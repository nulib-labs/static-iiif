// Collection reconciliation and the /collections routes.
//
// Membership is authoritative in each manifest's `partOf`. The documents under
// `presentation/collection/` are a derived projection: maintained incrementally
// here, and rebuildable from the manifests alone by reindexCollections.
//
// planReconciliation is pure and does the thinking; applyReconciliation does the
// IO in a deliberate order. That split is what makes this testable without
// mocking the SDK.
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

const {listManifestSummaries} = require("../../../shared/manifest");
const {extractLabel} = require("../../../shared/language");
const {
  COLLECTION_PREFIX,
  COLLECTION_OBJECT,
  ROOT_COLLECTION_SLUG,
  MAX_COLLECTIONS_PER_WORK,
  CollectionNameError,
  slugifyCollectionLabel,
  collectionObjectKey,
  rootCollectionKey,
  managedCollectionRefs,
  applyCollections,
  buildCollectionDocument,
  buildRootCollectionDocument,
  createRootCollectionTemplate,
  rootCollectionSummaries,
  serializeCollection,
  planReconciliation,
  canonicalizeCollectionLabels,
  manifestThumbnail,
} = require("../../../shared/collection");
const {jsonResponse, parseBody, isNotFound} = require("./http");
const {readImportStatus} = require("./importAssets");

const s3 = new S3Client({});
const bucket = process.env.IIIF_BUCKET;
const baseUrl = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");

// ---------------------------------------------------------------------------
// S3 access
// ---------------------------------------------------------------------------

async function streamToString(body) {
  if (typeof body === "string") return body;
  if (body && typeof body.transformToString === "function") return body.transformToString();
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(key) {
  try {
    const response = await s3.send(new GetObjectCommand({Bucket: bucket, Key: key}));
    return JSON.parse(await streamToString(response.Body));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeJson(key, document) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: serializeCollection(document),
      ContentType: "application/json",
    }),
  );
}

async function readRoot() {
  return readJson(rootCollectionKey());
}

// The root must be materialized, not synthesized on read: it is publicly
// dereferenceable and a downstream consumer must not get a 404. IfNoneMatch
// makes this a true create-if-absent, so two racing requests can't fight.
async function ensureRoot() {
  const existing = await readRoot();
  if (existing) return existing;

  const template = createRootCollectionTemplate({baseUrl});
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: rootCollectionKey(),
        Body: serializeCollection(template),
        ContentType: "application/json",
        IfNoneMatch: "*",
      }),
    );
  } catch (error) {
    // Someone else created it between our read and our write. Theirs is fine.
    if (error?.$metadata?.httpStatusCode !== 412 && error?.name !== "PreconditionFailed") {
      throw error;
    }
    return (await readRoot()) || template;
  }
  return template;
}

// Order matters: every surviving leaf, then the root, then the deletions. That
// keeps `root ⊆ existing leaf documents` true at every intermediate state, so a
// crash can never leave the root advertising a collection that 404s.
async function applyReconciliation(plan) {
  for (const write of plan.leafWrites) {
    await writeJson(write.key, write.document);
  }
  if (plan.rootChanged) {
    await writeJson(rootCollectionKey(), plan.rootNext);
  }
  for (const removal of plan.leafDeletes) {
    await s3.send(new DeleteObjectCommand({Bucket: bucket, Key: removal.key}));
  }
  return {written: plan.leafWrites.length, deleted: plan.leafDeletes.length};
}


// Bring the projection in line with one manifest.
//
//   desired === null  -> membership unchanged; refresh cached labels/thumbnails
//   desired === []    -> remove from everything (used by the delete path)
//   removed           -> the manifest itself is gone
async function reconcileManifestCollections({
  manifest,
  desired = null,
  previous,
  removed = false,
  root: knownRoot,
}) {
  // `previous` must describe the membership as it was BEFORE the manifest was
  // updated. Deriving it from an already-updated manifest silently drops every
  // removal out of the touched set, leaving the abandoned collection behind
  // until the next reindex.
  const current = previous || managedCollectionRefs(manifest?.partOf, {baseUrl});
  const target = desired === null ? current : desired;

  const root = knownRoot || (await ensureRoot());
  const touched = new Set([...current.map((ref) => ref.slug), ...target.map((ref) => ref.slug)]);
  if (!touched.size) {
    return {ok: true, written: 0, deleted: 0, collections: rootCollectionSummaries(root)};
  }

  const leaves = {};
  await Promise.all(
    [...touched].map(async (slug) => {
      leaves[slug] = await readJson(collectionObjectKey(slug));
    }),
  );

  const plan = planReconciliation({
    baseUrl,
    member: {
      manifestId: manifest.id,
      label: extractLabel(manifest.label),
      thumbnail: manifestThumbnail(manifest),
    },
    removed,
    desired: target,
    root,
    leaves,
  });
  const result = await applyReconciliation(plan);
  return {ok: true, ...result, collections: plan.collections};
}

// Never let projection maintenance fail a request whose authoritative write
// already succeeded — saying "failed" would be false in the direction that
// matters. Retrying the same request repairs it, and so does a reindex.
async function reconcileQuietly(args) {
  try {
    return await reconcileManifestCollections(args);
  } catch (error) {
    console.error("Collection reconcile failed", error);
    return {ok: false, error: error.message};
  }
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function parseDesiredCollections(body) {
  const raw = body?.collections;
  if (!Array.isArray(raw)) {
    throw new CollectionNameError("collections must be an array");
  }
  if (raw.length > MAX_COLLECTIONS_PER_WORK) {
    throw new CollectionNameError(
      `A work can belong to at most ${MAX_COLLECTIONS_PER_WORK} collections`,
    );
  }

  const bySlug = new Map();
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new CollectionNameError("Each collection must be a non-empty string");
    }
    const slug = slugifyCollectionLabel(entry);
    // First occurrence wins, so a caller sending both "Maps" and "maps" gets one.
    if (!bySlug.has(slug)) bySlug.set(slug, {slug, label: entry.trim()});
  }
  return [...bySlug.values()];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// PUT /manifests/{id}/collections
async function handleManifestCollectionsRoute({
  method,
  identifier,
  event,
  readManifest,
  writeManifest,
  manifestDetail,
}) {
  if (method !== "PUT") {
    return jsonResponse(405, {error: "Method not allowed"});
  }

  let desired;
  try {
    desired = parseDesiredCollections(parseBody(event));
  } catch (error) {
    if (error instanceof CollectionNameError || error.message === "Invalid JSON payload") {
      return jsonResponse(400, {error: error.message});
    }
    throw error;
  }

  try {
    // An import holds a stale copy of the manifest for minutes at a time and
    // writes it back wholesale, which would silently revert this edit.
    const importStatus = await readImportStatus(identifier).catch(() => null);
    if (importStatus?.status === "in-progress") {
      return jsonResponse(409, {
        error: "This work is still importing — try again when it finishes",
      });
    }

    const manifest = await readManifest(identifier);
    // Captured before the update: this is how the collections a work is LEAVING
    // stay in the reconciler's touched set.
    const previous = managedCollectionRefs(manifest?.partOf, {baseUrl});
    // Resolve names against the collections that already exist before writing,
    // so a work never caches a spelling its collection does not use.
    const root = await ensureRoot();
    const canonical = canonicalizeCollectionLabels(desired, root);
    const next = applyCollections(manifest, {baseUrl, collections: canonical});
    await writeManifest(identifier, next);

    const {collections, ...reconciliation} = await reconcileQuietly({
      manifest: next,
      desired: canonical,
      previous,
      root,
    });
    return jsonResponse(200, {
      manifest: manifestDetail(identifier, next),
      // The vocabulary comes back with the write, so the UI needs no follow-up
      // GET and can't race one against its own save.
      collections: collections || [],
      reconciliation,
    });
  } catch (error) {
    if (isNotFound(error)) {
      return jsonResponse(404, {error: "Manifest not found"});
    }
    console.error("Update collections failed", error);
    return jsonResponse(500, {error: "Unable to update collections"});
  }
}

// GET /collections, POST /collections/reindex
async function handleCollectionsRoute({method, segments, readManifest}) {
  if (segments.length === 1) {
    if (method !== "GET") {
      return jsonResponse(405, {error: "Method not allowed"});
    }
    try {
      // Exactly one GetObject — the whole point of keeping the root current.
      const root = await ensureRoot();
      return jsonResponse(200, {
        root: {id: root.id, label: extractLabel(root.label)},
        collections: rootCollectionSummaries(root),
      });
    } catch (error) {
      console.error("List collections failed", error);
      return jsonResponse(500, {error: "Unable to list collections"});
    }
  }

  if (segments.length === 2 && segments[1] === "reindex") {
    if (method !== "POST") {
      return jsonResponse(405, {error: "Method not allowed"});
    }
    try {
      return jsonResponse(200, await reindexCollections({readManifest}));
    } catch (error) {
      console.error("Reindex collections failed", error);
      return jsonResponse(500, {error: error.message});
    }
  }

  return jsonResponse(404, {error: "Unknown endpoint"});
}

// Full rebuild from the manifest corpus, mirroring POST /search/reindex —
// including the prune, without which deleted memberships resurrect.
//
// This is the repair story that makes manifest-authoritative safe: every
// collection document is a pure function of the manifests, so partial writes,
// hand-edits and base-URL changes are all fixed by one button.
async function reindexCollections({readManifest}) {
  const startedAt = Date.now();
  const summaries = await listManifestSummaries({s3, bucket});

  const bySlug = new Map();
  for (const summary of summaries) {
    const manifest = await readManifest(summary.identifier).catch(() => null);
    if (!manifest) continue;
    for (const ref of managedCollectionRefs(manifest.partOf, {baseUrl})) {
      if (!bySlug.has(ref.slug)) bySlug.set(ref.slug, {labels: [], members: []});
      const group = bySlug.get(ref.slug);
      group.labels.push({identifier: summary.identifier, label: ref.label});
      group.members.push({
        manifestId: manifest.id,
        label: summary.label,
        thumbnail: manifestThumbnail(manifest),
      });
    }
  }

  const collections = [];
  let written = 0;
  for (const [slug, group] of bySlug) {
    // Deterministic canonical label: the earliest member by identifier names it.
    const [canonical] = [...group.labels].sort((a, b) => a.identifier.localeCompare(b.identifier));
    const distinct = new Set(group.labels.map((entry) => entry.label));
    if (distinct.size > 1) {
      console.warn(`Collection ${slug} has conflicting labels: ${[...distinct].join(" | ")}`);
    }
    const label = canonical?.label || slug;
    const members = [...group.members].sort(
      (a, b) => a.label.localeCompare(b.label) || a.manifestId.localeCompare(b.manifestId),
    );

    const document = buildCollectionDocument({baseUrl, slug, label, members});
    await writeJson(collectionObjectKey(slug), document);
    written += 1;
    collections.push({
      slug,
      label,
      thumbnail: document.thumbnail || null,
      itemCount: members.length,
    });
  }

  collections.sort((a, b) => a.label.localeCompare(b.label) || a.slug.localeCompare(b.slug));
  await writeJson(rootCollectionKey(), buildRootCollectionDocument({baseUrl, collections}));

  const deleted = await pruneCollections(new Set(bySlug.keys()));
  return {
    collections: collections.length,
    manifests: summaries.length,
    written,
    deleted,
    tookMs: Date.now() - startedAt,
  };
}

async function pruneCollections(keep) {
  let deleted = 0;
  let continuationToken;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${COLLECTION_PREFIX}/`,
        ContinuationToken: continuationToken,
      }),
    );
    const stale = (response.Contents || [])
      .filter((object) => object.Key.endsWith(`/${COLLECTION_OBJECT}`))
      .map((object) => ({key: object.Key, slug: object.Key.split("/")[2]}))
      // The root is never pruned, however empty it gets.
      .filter(({slug}) => slug && slug !== ROOT_COLLECTION_SLUG && !keep.has(slug));

    for (const {key} of stale) {
      await s3.send(new DeleteObjectCommand({Bucket: bucket, Key: key}));
      deleted += 1;
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return deleted;
}

module.exports = {
  applyReconciliation,
  reconcileManifestCollections,
  reconcileQuietly,
  parseDesiredCollections,
  handleCollectionsRoute,
  handleManifestCollectionsRoute,
  reindexCollections,
  ensureRoot,
  readRoot,
};
