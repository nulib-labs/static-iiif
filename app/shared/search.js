// The search index: names, mappings and document shapes.
//
// Pure — no AWS SDK, no IO. The signed HTTP client lives in
// app/shared/opensearch.js; everything here is a function of its arguments so
// the naming rules and both document shapes are unit-testable.
//
// Topology. One WORKING index per stack, carrying every collection and
// filtered by a `collection` term at query time. Published indexes are per
// collection per publish run, behind a stable alias the downstream site points
// at:
//
//   {prefix}.working              the admin UI reads this
//   {prefix}.{slug}.pub.{runId}   one run's frozen output
//   {prefix}.{slug}               alias -> whichever pub index is live
//   {prefix}.{slug}.staged        alias -> the candidate awaiting its flip
//
// Working is one index rather than one per collection because the OpenSearch
// domain is shared by every developer's personal stack, and a small domain
// runs out of shards long before it runs out of disk. Published stays per
// collection because that is what makes the alias flip atomic for one
// collection without touching another's.

const {slugifyCollectionLabel, collectionSlugPattern} = require("./collection");

// "." separates the parts, not "-": a slug is [a-z0-9-]+, so with a hyphen the
// staged alias of `my-coll` and the live alias of `my-coll-staged` would be
// the same string.
//
// That alone is not enough. A reserved word sitting in a slug's position is
// still ambiguous — `{prefix}.working` is both the working index and the live
// alias of a collection someone named "Working". So every reserved segment
// starts with "_", which a slug cannot contain, and the segment counts differ
// too. OpenSearch allows "_" inside an index name; only a LEADING "_", "-",
// "+" or "." is reserved, and the prefix is always a real name.
//
//   {prefix}._working              2 segments, second is not a slug
//   {prefix}.{slug}                2 segments, second is a slug
//   {prefix}.{slug}._staged        3
//   {prefix}.{slug}._pub.{runId}   4
const SEP = ".";
const WORKING_SUFFIX = "_working";
const PUBLISHED_INFIX = "_pub";
const STAGED_SUFFIX = "_staged";

const indexPrefixPattern = /^[a-z0-9][a-z0-9_-]*$/;
// A run id only has to be unique and sortable. Timestamps alone are not: two
// runs in the same second would collide, and index creation treats "already
// exists" as success, so the second run would quietly write into the first
// one's candidate.
const runIdPattern = /^[a-z0-9]+$/;

class SearchNameError extends Error {}

function assertPrefix(prefix) {
  if (!indexPrefixPattern.test(prefix || "")) {
    throw new SearchNameError(
      `Search index prefix must be lowercase letters, digits, "_" or "-", and start with a letter or digit: ${prefix}`,
    );
  }
  return prefix;
}

function assertSlug(slug) {
  if (!collectionSlugPattern.test(slug || "")) {
    throw new SearchNameError(`Not a collection slug: ${slug}`);
  }
  return slug;
}

function assertRunId(runId) {
  if (!runIdPattern.test(runId || "")) {
    throw new SearchNameError(`Not a run id: ${runId}`);
  }
  return runId;
}

function workingIndexName(prefix) {
  return [assertPrefix(prefix), WORKING_SUFFIX].join(SEP);
}

function publishedIndexName(prefix, slug, runId) {
  return [assertPrefix(prefix), assertSlug(slug), PUBLISHED_INFIX, assertRunId(runId)].join(SEP);
}


// True only for a name this stack owns, so garbage collection on the shared
// domain can never touch another stack's index.
function isOwnIndexName(prefix, name) {
  return String(name || "").startsWith(`${prefix}${SEP}`);
}
// What a downstream site points at.
function liveAliasName(prefix, slug) {
  return [assertPrefix(prefix), assertSlug(slug)].join(SEP);
}

// What the asset publish points at its candidate, so "is something staged?" is
// one alias read rather than a guess from index names — which stops being a
// total order the moment two candidates can exist.
function stagedAliasName(prefix, slug) {
  return [assertPrefix(prefix), assertSlug(slug), STAGED_SUFFIX].join(SEP);
}

// Reads a published index name back apart, or null if it is not one. Used to
// garbage-collect candidates that no alias points at.
function parsePublishedIndexName(prefix, name) {
  const parts = String(name || "").split(SEP);
  if (parts.length !== 4) return null;
  const [candidatePrefix, slug, infix, runId] = parts;
  if (candidatePrefix !== prefix || infix !== PUBLISHED_INFIX) return null;
  if (!collectionSlugPattern.test(slug) || !runIdPattern.test(runId)) return null;
  return {slug, runId};
}

// --- documents -------------------------------------------------------------

// `_id` is the plain workId. The base64url-of-the-manifest-URL id this used to
// carry existed only because one global index had to key on something globally
// unique across collections; scoped per collection, the work's own identifier
// already is.
const WORKING_INDEX_PROPERTIES = {
  title: {type: "text", fields: {keyword: {type: "keyword", ignore_above: 512}}},
  manifestId: {type: "keyword"},
  workId: {type: "keyword"},
  // keyword, not text: the scope filter is a `term` clause, which does not
  // match an analyzed field.
  collection: {type: "keyword"},
  thumbnails: {type: "keyword", index: false},
  itemCount: {type: "integer"},
  // sha256 of the exact bytes written to S3, and how the collection page tells
  // a changed work from a published one.
  contentHash: {type: "keyword"},
  syncState: {type: "keyword"},
  // Publishing a collection with an import in flight would freeze a
  // half-rewritten manifest, so the precheck needs to be able to ask.
  importing: {type: "boolean"},
  updatedAt: {type: "date"},
};

// Deliberately smaller: this is what a downstream site reads, so it carries no
// field that is about how THIS app works. thumbnails is the one addition over
// the old shape — a site rendering a result list otherwise has to fetch every
// manifest to draw it.
const PUBLISHED_INDEX_PROPERTIES = {
  title: {type: "text", fields: {keyword: {type: "keyword", ignore_above: 512}}},
  manifestId: {type: "keyword"},
  thumbnails: {type: "keyword", index: false},
  itemCount: {type: "integer"},
};

const SYNC_NEW = "new";
const SYNC_CHANGED = "changed";
const SYNC_PUBLISHED = "published";

function buildWorkingDocument({
  workId,
  manifestUrl,
  label,
  collection,
  thumbnails = [],
  itemCount = 0,
  contentHash = null,
  syncState = SYNC_NEW,
  importing = false,
  updatedAt = null,
}) {
  return {
    workId,
    manifestId: manifestUrl,
    title: label || "",
    collection: collection || null,
    thumbnails,
    itemCount,
    contentHash,
    syncState,
    importing,
    updatedAt: updatedAt || new Date().toISOString(),
  };
}

function buildPublishedDocument({manifestUrl, label, thumbnails = [], itemCount = 0}) {
  return {
    manifestId: manifestUrl,
    title: label || "",
    thumbnails,
    itemCount,
  };
}

module.exports = {
  SEP,
  SearchNameError,
  indexPrefixPattern,
  runIdPattern,
  workingIndexName,
  publishedIndexName,
  liveAliasName,
  stagedAliasName,
  isOwnIndexName,
  parsePublishedIndexName,
  WORKING_INDEX_PROPERTIES,
  PUBLISHED_INDEX_PROPERTIES,
  SYNC_NEW,
  SYNC_CHANGED,
  SYNC_PUBLISHED,
  buildWorkingDocument,
  buildPublishedDocument,
  slugifyCollectionLabel,
};
