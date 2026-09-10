// The three publish endpoints. Starting and observing a run, and the flip.
//
// The run itself is a Step Functions state machine (see the publish Lambda);
// this only starts it and reports on it. The flip is synchronous on purpose:
// it is one atomic _aliases call, so there is nothing to show progress for.

const crypto = require("node:crypto");
const {SFNClient, StartExecutionCommand, DescribeExecutionCommand} = require("@aws-sdk/client-sfn");
const {jsonResponse, parseBody} = require("./http");
const {canPublish} = require("../../../shared/access");
const {INTERNAL_PREFIX, PUBLISHED} = require("../../../shared/space");
const {buildCollectionId} = require("../../../shared/collection");
const {
  publishedIndexName,
  liveAliasName,
  stagedAliasName,
  parsePublishedIndexName,
} = require("../../../shared/search");
const {aliasFlipActions} = require("../../../shared/publish");
const {updateAliases, getAliases, deleteIndex} = require("../../../shared/opensearch");
const {readJson, putJson, listKeys} = require("./publishStore");

const sfn = new SFNClient({});
const stateMachineArn = process.env.PUBLISH_STATE_MACHINE_ARN || "";
const prefix = process.env.SEARCH_INDEX_PREFIX || "";
const baseUrl = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");
const searchEndpoint = (process.env.OPENSEARCH_ENDPOINT || "").replace(/\/$/, "");

const statusKeyFor = (slug) => `${INTERNAL_PREFIX}/publish/${slug}/status.json`;
const batchesPrefix = (slug, runId) => `${INTERNAL_PREFIX}/publish/${slug}/${runId}/batches/`;

const TERMINAL = new Set(["succeeded", "partial", "failed", "idle"]);

// Which index each of the collection's two aliases points at. Derived from
// OpenSearch itself, so there is no state file to fall out of step — and read
// through /_alias rather than /_cat/indices, which is a cluster-monitor API a
// scoped resource policy can deny.
async function aliasState(slug) {
  const aliases = await getAliases(`${prefix}.${slug}*`);
  const live = liveAliasName(prefix, slug);
  const staged = stagedAliasName(prefix, slug);
  let liveIndex = null;
  let stagedIndex = null;
  for (const [index, info] of Object.entries(aliases)) {
    const names = Object.keys(info.aliases || {});
    if (names.includes(live)) liveIndex = index;
    if (names.includes(staged)) stagedIndex = index;
  }
  return {liveIndex, stagedIndex};
}

// The execution name is deterministic (`{slug}-{runId}`), so its ARN is
// derivable — which is what lets a stuck "running" status be reconciled
// against reality.
function executionArnFor(slug, runId) {
  if (!stateMachineArn) return null;
  const name = `${slug}-${runId}`.slice(0, 80);
  return `${stateMachineArn.replace(":stateMachine:", ":execution:")}:${name}`;
}

// A status object saying "running" is a CLAIM, not a fact.
//
// Step Functions can fail an execution without RecordFailure ever running:
// `States.ALL` does not catch `States.Runtime`, which is what a bad JSONPath in
// a state's Parameters raises. Left unreconciled, that pins the collection at
// "running" for ever, and the start route below refuses every retry with a 409
// that nothing in the UI can clear.
//
// So a "running" status is always checked against the execution itself. Errors
// reading it are swallowed deliberately: failing to describe an execution is
// not evidence that nothing is running, and unlocking on a bad signal would let
// two runs write the same collection.
async function readStatus(slug) {
  const stored = await readJson(statusKeyFor(slug));
  const status = stored?.document || {status: "idle"};
  if (status.status !== "running" || !status.runId) return status;

  const executionArn = executionArnFor(slug, status.runId);
  if (!executionArn) return status;

  try {
    const live = await sfn.send(new DescribeExecutionCommand({executionArn}));
    if (live.status === "RUNNING") return status;
    return {
      ...status,
      status: live.status === "SUCCEEDED" ? "succeeded" : "failed",
      phase: live.status === "SUCCEEDED" ? "Done" : "Failed",
      error:
        status.error ||
        `The run ended as ${live.status} without reporting a result. Its state machine execution is in the Step Functions console.`,
      // Surfaced so the UI can say the state was inferred rather than reported.
      reconciled: true,
    };
  } catch (error) {
    if (error?.name === "ExecutionDoesNotExist") {
      return {
        ...status,
        status: "failed",
        phase: "Failed",
        error: "The run was claimed but its execution never started.",
        reconciled: true,
      };
    }
    console.error("Unable to describe the publish execution", error);
    return status;
  }
}

async function handlePublishRoute({method, segments, principal, event}) {
  const slug = decodeURIComponent(segments[1]);

  // GET /collections/{slug}/publish — the run's progress.
  if (method === "GET" && segments.length === 3) {
    try {
      const [status, aliases] = await Promise.all([readStatus(slug), aliasState(slug)]);
      let written = status.written || 0;
      if (status.status === "running" && status.runId) {
        // Progress is a key count, not a shared counter: each batch writes its
        // own object, so nothing contends and a page reload picks the run back
        // up from S3 rather than from memory.
        written = (await listKeys(batchesPrefix(slug, status.runId))).length;
      }
      return jsonResponse(200, {
        ...status,
        batchesDone: written,
        liveIndex: aliases.liveIndex,
        stagedIndex: aliases.stagedIndex,
        // What a downstream site actually consumes. Built here because the
        // Lambda knows IIIF_BASE_URL; the UI's VITE_IIIF_BASE_URL is the IMAGE
        // API base, which is a different host entirely.
        // The three things a downstream site needs: what to crawl, where to
        // send a query, and what to call the index. The alias is useless
        // without the endpoint.
        consumes: {
          collection: buildCollectionId(baseUrl, slug, PUBLISHED),
          searchEndpoint,
          searchAlias: liveAliasName(prefix, slug),
        },
        // The second button is only meaningful once a candidate exists that
        // the live alias is not already on.
        canPublishIndex: Boolean(aliases.stagedIndex) && aliases.stagedIndex !== aliases.liveIndex,
      });
    } catch (error) {
      console.error("Read publish status failed", error);
      return jsonResponse(500, {error: "Unable to read publish status"});
    }
  }

  // POST /collections/{slug}/publish — start a run.
  if (method === "POST" && segments.length === 3) {
    if (!canPublish(principal, slug)) {
      return jsonResponse(403, {error: "You can only publish a collection you have been granted"});
    }
    if (!stateMachineArn) {
      return jsonResponse(503, {error: "Publishing is not configured for this stack"});
    }
    try {
      const current = await readStatus(slug);
      if (current.status === "running") {
        return jsonResponse(409, {error: "A publish is already running for this collection"});
      }
      const runId = crypto.randomBytes(6).toString("hex");
      // Claim the run before starting it. A conditional write is the mutex:
      // If-None-Match when nothing has ever run, If-Match on what we just
      // read otherwise, so two concurrent starts cannot both win.
      await putJson(
        statusKeyFor(slug),
        {slug, runId, status: "running", phase: "Planning…", startedAt: new Date().toISOString()},
        current.status === "idle" ? {IfNoneMatch: "*"} : {IfMatch: current.etag},
      );
      await sfn.send(
        new StartExecutionCommand({
          stateMachineArn,
          name: `${slug}-${runId}`.slice(0, 80),
          input: JSON.stringify({slug, runId, requestedBy: principal?.email || null}),
        }),
      );
      return jsonResponse(202, {slug, runId, status: "running"});
    } catch (error) {
      if (error?.name === "PreconditionFailed" || error?.$metadata?.httpStatusCode === 412) {
        return jsonResponse(409, {error: "A publish is already running for this collection"});
      }
      console.error("Start publish failed", error);
      return jsonResponse(500, {error: "Unable to start publishing"});
    }
  }

  // POST /collections/{slug}/publish/index — the flip.
  if (method === "POST" && segments.length === 4 && segments[3] === "index") {
    if (!canPublish(principal, slug)) {
      return jsonResponse(403, {error: "You can only publish a collection you have been granted"});
    }
    try {
      const {liveIndex, stagedIndex} = await aliasState(slug);
      if (!stagedIndex) {
        return jsonResponse(409, {error: "Publish the IIIF assets first — there is nothing staged"});
      }
      if (stagedIndex === liveIndex) {
        return jsonResponse(409, {error: "That index is already live"});
      }
      await updateAliases(
        aliasFlipActions({
          index: stagedIndex,
          liveAlias: liveAliasName(prefix, slug),
          stagedAlias: stagedAliasName(prefix, slug),
          previousIndex: liveIndex,
        }),
      );
      // Only now, and only the index that just stopped being live. Never at
      // plan time and never an index carrying an alias, so a concurrent run's
      // candidate is safe.
      if (liveIndex && parsePublishedIndexName(prefix, liveIndex)) {
        await deleteIndex(liveIndex);
      }
      return jsonResponse(200, {liveIndex: stagedIndex, previousIndex: liveIndex});
    } catch (error) {
      console.error("Publish index failed", error);
      return jsonResponse(500, {error: "Unable to publish the search index"});
    }
  }

  return jsonResponse(405, {error: "Method not allowed"});
}

module.exports = {handlePublishRoute, aliasState, publishedIndexName};
