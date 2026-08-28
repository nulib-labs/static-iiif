const {S3Client} = require("@aws-sdk/client-s3");
const {defaultProvider} = require("@aws-sdk/credential-provider-node");
const {SignatureV4} = require("@smithy/signature-v4");
const {HttpRequest} = require("@smithy/protocol-http");
const {Sha256} = require("@aws-crypto/sha256-js");
const {listManifestSummaries} = require("../../../shared/manifest");
const {buildSearchDocument} = require("../../../shared/search");

const BULK_BATCH_SIZE = 500;

const s3 = new S3Client({});
const bucket = process.env.IIIF_BUCKET;
const indexName = process.env.SEARCH_INDEX_NAME;
const endpoint = new URL(process.env.OPENSEARCH_ENDPOINT);

const signer = new SignatureV4({
  service: "es",
  region: process.env.AWS_REGION,
  credentials: defaultProvider(),
  sha256: Sha256,
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
    body: JSON.stringify(payload),
  };
}

async function osRequest(method, path, body, contentType = "application/json") {
  const request = new HttpRequest({
    method,
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    path,
    headers: {
      host: endpoint.hostname,
      "content-type": contentType,
    },
    body,
  });
  const signed = await signer.sign(request);
  const response = await fetch(`${endpoint.origin}${path}`, {
    method: signed.method,
    headers: signed.headers,
    body: signed.body,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    json = null;
  }
  return {status: response.status, json, text};
}

async function ensureIndex() {
  const status = await osRequest("HEAD", `/${indexName}`);
  if (status.status === 200) {
    return;
  }
  const body = JSON.stringify({
    settings: {number_of_shards: 1, number_of_replicas: 1},
    mappings: {
      properties: {
        title: {type: "text", fields: {keyword: {type: "keyword", ignore_above: 512}}},
        manifestId: {type: "keyword"},
      },
    },
  });
  const created = await osRequest("PUT", `/${indexName}`, body);
  if (created.status >= 300) {
    throw new Error(`Failed to create index: ${created.status} ${created.text}`);
  }
}

function buildBulkBody(actions) {
  return actions.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

async function bulkUpsert(docs) {
  let indexed = 0;
  let failed = 0;
  for (let i = 0; i < docs.length; i += BULK_BATCH_SIZE) {
    const batch = docs.slice(i, i + BULK_BATCH_SIZE);
    const lines = [];
    for (const doc of batch) {
      lines.push({index: {_index: indexName, _id: doc.id}});
      lines.push(doc);
    }
    const response = await osRequest("POST", "/_bulk", buildBulkBody(lines), "application/x-ndjson");
    if (response.status >= 300) {
      failed += batch.length;
      console.error("Bulk upsert batch failed", response.status, response.text);
      continue;
    }
    const items = response.json?.items || [];
    for (const item of items) {
      const result = item.index || item.create || {};
      if (result.status && result.status >= 300) {
        failed += 1;
      } else {
        indexed += 1;
      }
    }
  }
  return {indexed, failed};
}

async function bulkDelete(ids) {
  if (ids.length === 0) return 0;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BULK_BATCH_SIZE) {
    const batch = ids.slice(i, i + BULK_BATCH_SIZE);
    const lines = batch.map((id) => ({delete: {_index: indexName, _id: id}}));
    const response = await osRequest("POST", "/_bulk", buildBulkBody(lines), "application/x-ndjson");
    if (response.status >= 300) {
      console.error("Bulk delete batch failed", response.status, response.text);
      continue;
    }
    deleted += batch.length;
  }
  return deleted;
}

async function listAllIndexedIds() {
  const ids = [];
  let searchAfter;
  for (;;) {
    const searchBody = {
      size: 1000,
      sort: [{_id: "asc"}],
      _source: false,
      query: {match_all: {}},
      ...(searchAfter ? {search_after: searchAfter} : {}),
    };
    const response = await osRequest("POST", `/${indexName}/_search`, JSON.stringify(searchBody));
    if (response.status >= 300) {
      throw new Error(`Failed to list indexed ids: ${response.status} ${response.text}`);
    }
    const hits = response.json?.hits?.hits || [];
    if (hits.length === 0) break;
    for (const hit of hits) {
      ids.push(hit._id);
    }
    searchAfter = hits[hits.length - 1].sort;
    if (hits.length < 1000) break;
  }
  return ids;
}

async function reindex() {
  const start = Date.now();
  await ensureIndex();

  const summaries = await listManifestSummaries({s3, bucket});
  const docs = summaries
    .filter((summary) => summary.manifestUrl)
    .map((summary) => buildSearchDocument({label: summary.label, manifestUrl: summary.manifestUrl}));

  const {indexed, failed} = await bulkUpsert(docs);

  const currentIds = new Set(docs.map((doc) => doc.id));
  const existingIds = await listAllIndexedIds();
  const staleIds = existingIds.filter((id) => !currentIds.has(id));
  const deleted = await bulkDelete(staleIds);

  return {indexed, deleted, failed, tookMs: Date.now() - start};
}

async function query(q) {
  const term = (q || "").trim();
  const body = JSON.stringify(
    term
      ? {size: 25, query: {match: {title: {query: term, fuzziness: "AUTO"}}}}
      : {size: 1000, query: {match_all: {}}},
  );
  const response = await osRequest("POST", `/${indexName}/_search`, body);
  if (response.status >= 300) {
    throw new Error(`Search failed: ${response.status} ${response.text}`);
  }
  const hits = response.json?.hits?.hits || [];
  return {
    hits: hits.map((hit) => ({
      id: hit._id,
      title: hit._source?.title || "",
      manifestId: hit._source?.manifestId || "",
    })),
  };
}

exports.handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
  const rawPath = event?.rawPath || event?.path || "/";
  const segments = rawPath.split("/").filter(Boolean);

  if (method === "OPTIONS") {
    return jsonResponse(200, {ok: true});
  }

  if (segments[0] !== "search") {
    return jsonResponse(404, {error: "Not found"});
  }

  if (method === "POST" && segments[1] === "reindex") {
    try {
      const result = await reindex();
      return jsonResponse(200, result);
    } catch (error) {
      console.error("Reindex failed", error);
      return jsonResponse(500, {error: error.message});
    }
  }

  if (method === "GET" && segments.length === 1) {
    try {
      const result = await query(event.queryStringParameters?.q);
      return jsonResponse(200, result);
    } catch (error) {
      console.error("Search query failed", error);
      return jsonResponse(500, {error: error.message});
    }
  }

  return jsonResponse(404, {error: "Unknown endpoint"});
};
