const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ImportError,
  validateSourceUrl,
  fetchSourceDocument,
  collectionMembers,
} = require("../sourceFetch");

// A stand-in for fetch. Only the four things fetchSourceDocument actually reads.
function stubFetch({status = 200, body = "{}", headers = {}} = {}) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: {get: (name) => headers[name.toLowerCase()] ?? null},
    text: async () => body,
  });
}

const json = (value) => JSON.stringify(value);

test("validateSourceUrl accepts http(s) and rejects the rest", () => {
  assert.equal(validateSourceUrl(" https://example.org/c.json "), "https://example.org/c.json");
  assert.throws(() => validateSourceUrl(""), /required/);
  assert.throws(() => validateSourceUrl("not a url"), /doesn't look like a valid URL/);
  assert.throws(() => validateSourceUrl("ftp://example.org/x"), /Only http\(s\)/);
});

test("validateSourceUrl names what it wanted, so the message fits the field", () => {
  assert.throws(() => validateSourceUrl("", {noun: "collection"}), /A collection URL is required/);
  assert.throws(() => validateSourceUrl(""), /A manifest URL is required/);
});

test("a redirect is reported, never followed", async () => {
  // redirect: "manual" is deliberate — following one would import from an
  // address the curator never pasted.
  await assert.rejects(
    fetchSourceDocument("https://example.org/c", {expect: "Collection", fetchImpl: stubFetch({status: 301})}),
    /returned a redirect/,
  );
});

test("a failed request carries the source's status", async () => {
  await assert.rejects(
    fetchSourceDocument("https://example.org/c", {expect: "Collection", fetchImpl: stubFetch({status: 404})}),
    /Source server returned 404/,
  );
});

test("an unreachable host is a 502, not a 400 — it is not the curator's fault", async () => {
  const boom = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  await assert.rejects(
    fetchSourceDocument("https://nope.invalid/c", {expect: "Collection", fetchImpl: boom}),
    (error) => error instanceof ImportError && error.status === 502,
  );
});

test("size is capped by content-length AND by what actually arrives", async () => {
  const big = {expect: "Manifest", maxBytes: 10};
  await assert.rejects(
    fetchSourceDocument("https://e.org/m", {
      ...big,
      fetchImpl: stubFetch({headers: {"content-length": "999"}}),
    }),
    /too large/,
  );
  // A source that sends no content-length must not slip past the cap.
  await assert.rejects(
    fetchSourceDocument("https://e.org/m", {...big, fetchImpl: stubFetch({body: "x".repeat(50)})}),
    /too large/,
  );
});

test("non-JSON is rejected before any type check", async () => {
  await assert.rejects(
    fetchSourceDocument("https://e.org/m", {expect: "Manifest", fetchImpl: stubFetch({body: "<html>"})}),
    /did not return valid JSON/,
  );
});

test("each type says so by name when handed the other one", async () => {
  // Pasting the wrong one of the two is the single most likely mistake at this
  // field, so the message has to point at the other screen rather than report a
  // generic type error.
  await assert.rejects(
    fetchSourceDocument("https://e.org/x", {
      expect: "Manifest",
      fetchImpl: stubFetch({body: json({type: "Collection"})}),
    }),
    /That's a Collection\. Use Import Collection/,
  );
  await assert.rejects(
    fetchSourceDocument("https://e.org/x", {
      expect: "Collection",
      fetchImpl: stubFetch({body: json({type: "Manifest"})}),
    }),
    /That's a single Manifest\. Use Import Works/,
  );
});

test("anything that is neither is refused", async () => {
  await assert.rejects(
    fetchSourceDocument("https://e.org/x", {
      expect: "Collection",
      fetchImpl: stubFetch({body: json({type: "Canvas"})}),
    }),
    /Only IIIF Presentation 3.0 Collections/,
  );
});

test("a good document comes back parsed", async () => {
  const doc = {type: "Collection", label: {none: ["Maps"]}, items: []};
  const result = await fetchSourceDocument("https://e.org/c", {
    expect: "Collection",
    fetchImpl: stubFetch({body: json(doc)}),
  });
  assert.deepEqual(result, doc);
});

test("collectionMembers takes the Manifests and counts the sub-collections", () => {
  // Nested collections are skipped rather than recursed into: recursion would
  // make one paste an unbounded walk of somebody else's tree.
  const {manifests, skippedCollections} = collectionMembers({
    items: [
      {type: "Manifest", id: "https://e.org/1"},
      {type: "Collection", id: "https://e.org/sub"},
      {type: "Manifest", id: "https://e.org/2"},
      {type: "Manifest"}, // no id — not addressable, so not a member
      null,
    ],
  });
  assert.deepEqual(manifests.map((m) => m.id), ["https://e.org/1", "https://e.org/2"]);
  assert.equal(skippedCollections, 1);
});

test("collectionMembers tolerates a collection with no items", () => {
  assert.deepEqual(collectionMembers({}), {manifests: [], skippedCollections: 0});
  assert.deepEqual(collectionMembers(null), {manifests: [], skippedCollections: 0});
});

// ---------------------------------------------------------------------------
// Dropping A/V
// ---------------------------------------------------------------------------

const {paintingBody, imageCanvasesOnly} = require("../sourceFetch");
const avManifest = require("../__fixtures__/nul-av-manifest.json");

const canvas = (type) => ({
  type: "Canvas",
  items: [{type: "AnnotationPage", items: [{motivation: "painting", body: {type}}]}],
});

test("A/V is dropped per CANVAS, so a mixed work keeps its images", () => {
  // The fixture is a real NUL audio work: one Sound canvas (the recording) plus
  // three Image canvases (photographs of the tape and its insert). Dropping the
  // whole work would lose the images too; keeping the Sound canvas would leave a
  // published manifest pointing at the source's streaming server.
  const bodies = avManifest.items.map((item) => paintingBody(item)?.type);
  assert.deepEqual(bodies, ["Sound", "Image", "Image", "Image"]);

  const {items, dropped} = imageCanvasesOnly(avManifest);
  assert.equal(dropped, 1);
  assert.equal(items.length, 3);
  assert.ok(items.every((item) => paintingBody(item).type === "Image"));
  // Nothing that survives may reference the streaming host.
  assert.ok(!JSON.stringify(items).includes("meadow-streaming"));
});

test("Video is dropped the same way Sound is", () => {
  const {items, dropped} = imageCanvasesOnly({
    items: [canvas("Image"), canvas("Video"), canvas("Sound"), canvas("Image")],
  });
  assert.equal(dropped, 2);
  assert.equal(items.length, 2);
});

test("an A/V-only work lands empty rather than failing", () => {
  // Allowed on purpose: triggerAssetImport no-ops on zero canvases, and the work
  // is re-imported when A/V support arrives. Better an empty work than a run
  // that dies on one bad member.
  assert.deepEqual(imageCanvasesOnly({items: [canvas("Sound")]}), {items: [], dropped: 1});
});

test("imageCanvasesOnly tolerates a manifest with no items, or odd canvases", () => {
  assert.deepEqual(imageCanvasesOnly({}), {items: [], dropped: 0});
  assert.deepEqual(imageCanvasesOnly(null), {items: [], dropped: 0});
  // A canvas with no painting annotation at all is dropped, not crashed on.
  assert.deepEqual(imageCanvasesOnly({items: [{type: "Canvas"}, null]}), {items: [], dropped: 2});
});

test("the original manifest is not mutated — the filter returns a new list", () => {
  const before = avManifest.items.length;
  imageCanvasesOnly(avManifest);
  assert.equal(avManifest.items.length, before);
});

test("throttling and 5xx are retryable; a bad paste is not", async () => {
  // A collection import lets retryable failures out of the batch so the state
  // machine backs off, instead of recording a few hundred works as permanently
  // failed because the source asked us to slow down.
  const statusOf = async (httpStatus) => {
    try {
      await fetchSourceDocument("https://e.org/c", {
        expect: "Collection",
        fetchImpl: stubFetch({status: httpStatus}),
      });
      return null;
    } catch (error) {
      return error;
    }
  };
  assert.equal((await statusOf(429)).retryable, true);
  assert.equal((await statusOf(503)).retryable, true);
  assert.equal((await statusOf(500)).retryable, true);
  // The answer to these would be the same on a second attempt.
  assert.equal((await statusOf(404)).retryable, false);
  assert.equal((await statusOf(403)).retryable, false);

  // An unreachable host is transient too.
  const unreachable = await fetchSourceDocument("https://nope.invalid/c", {
    expect: "Collection",
    fetchImpl: async () => {
      throw new Error("ENOTFOUND");
    },
  }).catch((error) => error);
  assert.equal(unreachable.retryable, true);

  // A malformed URL never reaches the network, so it is not retryable either.
  assert.equal(
    (() => {
      try {
        validateSourceUrl("nonsense");
      } catch (error) {
        return error.retryable;
      }
    })(),
    false,
  );
});

// ---------------------------------------------------------------------------
// Structural ids
// ---------------------------------------------------------------------------

const {localizeStructuralIds} = require("../sourceFetch");
const nulManifest = require("../__fixtures__/nul-manifest.json");

const OURS = "https://iiif.example.org/working/presentation/manifest/abc-123/manifest.json";
const BASE = "https://iiif.example.org/working/presentation/manifest/abc-123";

const allUrls = (value, out = []) => {
  if (Array.isArray(value)) value.forEach((v) => allUrls(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => allUrls(v, out));
  else if (typeof value === "string" && /^https?:/.test(value)) out.push(value);
  return out;
};

test("every id inside an imported work becomes ours", () => {
  // The bug this covers: only the top-level id used to be rewritten, so a work
  // imported from NUL kept THEIR identifiers for every canvas, page, annotation
  // and placeholder — ids that dereference to their canvas, serving their
  // pixels, from a manifest claiming to be ours.
  const manifest = localizeStructuralIds({...structuredClone(nulManifest), id: OURS});
  const canvas = manifest.items[0];

  assert.equal(canvas.id, `${BASE}/canvas/0`);
  assert.equal(canvas.items[0].id, `${BASE}/canvas/0/page/1`);
  assert.equal(canvas.items[0].items[0].id, `${BASE}/canvas/0/annotation/1`);
  // The target must follow the canvas, or the annotation paints onto nothing.
  assert.equal(canvas.items[0].items[0].target, `${BASE}/canvas/0`);
  assert.equal(canvas.placeholderCanvas.id, `${BASE}/canvas/0/placeholder`);
  assert.equal(canvas.placeholderCanvas.items[0].items[0].target, `${BASE}/canvas/0/placeholder`);
});

test("seeAlso, partOf and provider still point at the source — they are about the source", () => {
  // The fixture is a trimmed NUL manifest and carries partOf but not seeAlso or
  // provider, so those two are supplied here rather than assumed.
  const manifest = localizeStructuralIds({
    ...structuredClone(nulManifest),
    id: OURS,
    seeAlso: [{id: "https://api.dc.library.northwestern.edu/api/v2/works/6f336d7c", type: "Dataset"}],
    provider: [{id: "https://www.library.northwestern.edu/", type: "Agent"}],
  });
  assert.ok(manifest.seeAlso[0].id.includes("api.dc.library.northwestern.edu"));
  assert.ok(manifest.partOf[0].id.includes("api.dc.library.northwestern.edu"));
  assert.ok(allUrls(manifest.provider).some((u) => u.includes("northwestern.edu")));
});

test("nothing structural is left claiming the source's identity", () => {
  const manifest = localizeStructuralIds({...structuredClone(nulManifest), id: OURS});
  // Everything the source still owns must be reachable only through the fields
  // that are ABOUT it. Nothing under items[] may reference their API.
  const inside = allUrls(manifest.items);
  assert.equal(
    inside.filter((u) => u.includes("api.dc.library.northwestern.edu")).length,
    0,
    "a canvas, page, annotation or placeholder id still points at the source API",
  );
});

test("ids are derived from the index, so a resumed import re-mints them identically", () => {
  const once = localizeStructuralIds({...structuredClone(nulManifest), id: OURS});
  const twice = localizeStructuralIds({...structuredClone(nulManifest), id: OURS});
  assert.deepEqual(allUrls(once.items), allUrls(twice.items));
  // And running it again over its own output changes nothing.
  assert.deepEqual(allUrls(localizeStructuralIds(once).items), allUrls(once.items));
});

test("a fragment selector survives, because it says WHERE on the canvas", () => {
  const manifest = localizeStructuralIds({
    id: OURS,
    items: [
      {
        items: [
          {items: [{target: "https://source.org/canvas/9#xywh=10,20,30,40"}]},
        ],
      },
    ],
  });
  assert.equal(
    manifest.items[0].items[0].items[0].target,
    `${BASE}/canvas/0#xywh=10,20,30,40`,
  );
});

test("an object target is relabelled too, and odd shapes do not throw", () => {
  const manifest = localizeStructuralIds({
    id: OURS,
    items: [
      {items: [{items: [{target: {id: "https://source.org/c/1", type: "Canvas"}}]}]},
      null,
      {items: null},
      {items: [{items: [null]}]},
    ],
  });
  assert.equal(manifest.items[0].items[0].items[0].target.id, `${BASE}/canvas/0`);
  assert.equal(manifest.items[2].id, `${BASE}/canvas/2`);
});

test("a manifest with no usable id is left alone rather than given junk ids", () => {
  const orphan = {items: [{id: "https://source.org/c/1"}]};
  assert.equal(localizeStructuralIds(orphan).items[0].id, "https://source.org/c/1");
  assert.doesNotThrow(() => localizeStructuralIds(null));
});
