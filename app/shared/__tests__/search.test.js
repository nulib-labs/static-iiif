const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SearchNameError,
  workingIndexName,
  publishedIndexName,
  liveAliasName,
  stagedAliasName,
  isOwnIndexName,
  parsePublishedIndexName,
  WORKING_INDEX_PROPERTIES,
  PUBLISHED_INDEX_PROPERTIES,
  SYNC_NEW,
  buildWorkingDocument,
  buildPublishedDocument,
} = require("../search");

const PREFIX = "kdid-dev";

test("index and alias names", () => {
  assert.equal(workingIndexName(PREFIX), "kdid-dev._working");
  assert.equal(publishedIndexName(PREFIX, "eis", "k3f9a1"), "kdid-dev.eis._pub.k3f9a1");
  assert.equal(liveAliasName(PREFIX, "eis"), "kdid-dev.eis");
  assert.equal(stagedAliasName(PREFIX, "eis"), "kdid-dev.eis._staged");
});

// The reason the separator is "." and not "-". A slug is [a-z0-9-]+, so with a
// hyphen these two names would be the same string, and one collection's alias
// would silently be another's staged alias.
test('"." separates the parts because a hyphen would collide', () => {
  assert.notEqual(stagedAliasName(PREFIX, "my-coll"), liveAliasName(PREFIX, "my-coll-staged"));
  assert.equal(stagedAliasName(PREFIX, "my-coll"), "kdid-dev.my-coll._staged");
  assert.equal(liveAliasName(PREFIX, "my-coll-staged"), "kdid-dev.my-coll-staged");
  // And the reason reserved segments start with "_": without it the working
  // index and the live alias of a collection named "Working" are one name.
  assert.notEqual(workingIndexName(PREFIX), liveAliasName(PREFIX, "working"));
  assert.notEqual(stagedAliasName(PREFIX, "eis"), liveAliasName(PREFIX, "eis"));
});

test("isOwnIndexName keeps GC off other stacks on the shared domain", () => {
  assert.equal(isOwnIndexName(PREFIX, workingIndexName(PREFIX)), true);
  assert.equal(isOwnIndexName(PREFIX, publishedIndexName(PREFIX, "eis", "k1")), true);
  assert.equal(isOwnIndexName(PREFIX, "other-stack.eis._pub.k1"), false);
  assert.equal(isOwnIndexName(PREFIX, ""), false);
});

test("names are validated rather than silently malformed", () => {
  // OpenSearch index names must be lowercase, and a leading dot is reserved.
  assert.throws(() => workingIndexName("KDID-Dev"), SearchNameError);
  assert.throws(() => workingIndexName(".hidden"), SearchNameError);
  assert.throws(() => workingIndexName(""), SearchNameError);
  assert.throws(() => liveAliasName(PREFIX, "Not A Slug"), SearchNameError);
  assert.throws(() => publishedIndexName(PREFIX, "eis", "has.dot"), SearchNameError);
});

test("parsePublishedIndexName round-trips, and rejects everything else", () => {
  const name = publishedIndexName(PREFIX, "eis", "k3f9a1");
  assert.deepEqual(parsePublishedIndexName(PREFIX, name), {slug: "eis", runId: "k3f9a1"});
  assert.equal(parsePublishedIndexName(PREFIX, workingIndexName(PREFIX)), null);
  assert.equal(parsePublishedIndexName(PREFIX, liveAliasName(PREFIX, "eis")), null);
  assert.equal(parsePublishedIndexName(PREFIX, stagedAliasName(PREFIX, "eis")), null);
  // Another stack's index on the shared domain is not ours to garbage-collect.
  assert.equal(parsePublishedIndexName(PREFIX, "other-stack.eis.pub.k3f9a1"), null);
  assert.equal(parsePublishedIndexName(PREFIX, ""), null);
});

test("the working document carries what the admin UI needs", () => {
  const doc = buildWorkingDocument({
    workId: "abc",
    manifestUrl: "https://b/working/presentation/manifest/abc/manifest.json",
    label: "Aerial Survey",
    collection: "eis",
    thumbnails: ["https://img/1"],
    itemCount: 3,
    contentHash: "deadbeef",
    updatedAt: "2026-09-10T00:00:00.000Z",
  });
  assert.equal(doc.workId, "abc", "the UI builds a route from this, never by parsing a URL");
  assert.equal(doc.collection, "eis", "one index for the stack, filtered by a term");
  assert.equal(doc.syncState, SYNC_NEW, "a work nobody has published is new, not published");
  assert.equal(doc.importing, false);
  assert.equal(doc.contentHash, "deadbeef");
});

// What a downstream site reads. It must not learn anything about how this app
// works — no workId, no sync state, no collection field.
test("the published document is deliberately smaller", () => {
  const doc = buildPublishedDocument({
    manifestUrl: "https://b/published/presentation/manifest/abc/manifest.json",
    label: "Aerial Survey",
    thumbnails: ["https://img/1"],
    itemCount: 3,
  });
  assert.deepEqual(Object.keys(doc).sort(), ["itemCount", "manifestId", "thumbnails", "title"]);
  assert.match(doc.manifestId, /\/published\//);
  for (const field of ["workId", "syncState", "contentHash", "collection", "importing"]) {
    assert.equal(field in doc, false, `${field} is this app's business, not a consumer's`);
  }
});

test("mappings: the fields that are filtered on are keywords, not text", () => {
  assert.equal(WORKING_INDEX_PROPERTIES.collection.type, "keyword");
  assert.equal(WORKING_INDEX_PROPERTIES.syncState.type, "keyword");
  assert.equal(WORKING_INDEX_PROPERTIES.contentHash.type, "keyword");
  assert.equal(WORKING_INDEX_PROPERTIES.title.type, "text", "titles are searched, not filtered");
  assert.equal(PUBLISHED_INDEX_PROPERTIES.collection, undefined);
});
