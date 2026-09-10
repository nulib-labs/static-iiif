const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ROOT_COLLECTION_SLUG,
  PRESENTATION_CONTEXT,
  STATIC_IIIF_PREFIX,
  STATIC_IIIF_NAMESPACE,
  MANAGED_KEY,
  ITEM_COUNT_KEY,
  collectionSlugPattern,
  slugifyCollectionLabel,
  sanitizeCollectionSlug,
  collectionObjectKey,
  rootCollectionKey,
  buildCollectionId,
  collectionSlugFromId,
  normalizeContext,
  buildPartOfEntry,
  isManagedPartOfEntry,
  managedCollectionRefs,
  foreignPartOfEntries,
  stripForeignManagedEntries,
  applyCollections,
  buildCollectionDocument,
  buildRootCollectionDocument,
  createRootCollectionTemplate,
  rootCollectionSummaries,
} = require("../collection");

const BASE = "https://example-iiif.s3.us-east-1.amazonaws.com";
const nulManifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "__fixtures__", "nul-manifest.json"), "utf8"),
);

test("slugifyCollectionLabel: normal labels", () => {
  const cases = {
    "Environmental Impact Statements": "environmental-impact-statements",
    "ENVIRONMENTAL impact Statements": "environmental-impact-statements",
    "Maps, Plans & Surveys": "maps-plans-surveys",
    "  --Maps--  ": "maps",
    "Campus\tMaps\n": "campus-maps",
    "1974 Reports": "1974-reports",
    "Café Society": "cafe-society",
    "Ångström": "angstrom",
    ﬁles: "files",
    "already-a-slug": "already-a-slug",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(slugifyCollectionLabel(input), expected, input);
  }
});

test("slugifyCollectionLabel: idempotent, and output always matches the pattern", () => {
  const corpus = [
    "Environmental Impact Statements",
    "Maps, Plans & Surveys",
    "Café Society",
    "1974 Reports",
    "a".repeat(150),
  ];
  for (const input of corpus) {
    const once = slugifyCollectionLabel(input);
    assert.equal(slugifyCollectionLabel(once), once, `idempotent: ${input}`);
    assert.match(once, collectionSlugPattern);
    // The charset makes path traversal structurally impossible.
    assert.ok(!once.includes(".") && !once.includes("/"));
  }
});

test("slugifyCollectionLabel: truncates at a word boundary with no trailing dash", () => {
  // Under the 200-char label cap, but well over the 96-char slug cap.
  const label = `${"word ".repeat(30)}tail`;
  assert.ok(label.length < 200);
  const slug = slugifyCollectionLabel(label);
  assert.ok(slug.length <= 96, `length ${slug.length}`);
  assert.ok(!slug.endsWith("-"));
  assert.match(slug, collectionSlugPattern);
  assert.equal(slugifyCollectionLabel(slug), slug);
});

test("slugifyCollectionLabel: rejects unusable and reserved names", () => {
  for (const bad of ["", "   ", null, undefined, "!!!", "🙂", "···", "—"]) {
    assert.throws(() => slugifyCollectionLabel(bad), /required|doesn't contain/, String(bad));
  }
  for (const reserved of ["Index", "index", "  INDEX  "]) {
    assert.throws(() => slugifyCollectionLabel(reserved), /reserved/, reserved);
  }
  assert.throws(() => slugifyCollectionLabel("x".repeat(201)), /limited to 200/);
});

test("sanitizeCollectionSlug validates without transforming", () => {
  assert.equal(sanitizeCollectionSlug(" campus-maps "), "campus-maps");
  for (const bad of ["Campus Maps", "campus_maps", "campus--maps", "-maps", "maps-", "..", ""]) {
    assert.throws(() => sanitizeCollectionSlug(bad), /required|may only include/, bad);
  }
  assert.throws(() => sanitizeCollectionSlug("index"), /reserved/);
});

test("key and id builders", () => {
  // Keys are space-qualified and default to working: every caller but the
  // publish pipeline wants the draft.
  assert.equal(collectionObjectKey("campus-maps"), "working/presentation/collection/campus-maps/collection.json");
  // The root must be buildable even though its slug is reserved for users.
  assert.equal(rootCollectionKey(), "working/presentation/collection/index/collection.json");

  assert.equal(buildCollectionId(BASE, "campus-maps"), `${BASE}/working/presentation/collection/campus-maps/collection.json`);
  assert.equal(buildCollectionId(`${BASE}/`, "campus-maps"), buildCollectionId(BASE, "campus-maps"));
  assert.equal(buildCollectionId("", "campus-maps"), "working/presentation/collection/campus-maps/collection.json");

  // The published mirror of the same collection.
  assert.equal(
    collectionObjectKey("campus-maps", "published"),
    "published/presentation/collection/campus-maps/collection.json",
  );
  assert.equal(rootCollectionKey("published"), "published/presentation/collection/index/collection.json");
  assert.equal(
    buildCollectionId(BASE, "campus-maps", "published"),
    `${BASE}/published/presentation/collection/campus-maps/collection.json`,
  );
  assert.throws(() => collectionObjectKey("campus-maps", "live"), /Unknown space/);

  // The slug reads back out of either space's id.
  assert.equal(collectionSlugFromId(buildCollectionId(BASE, "campus-maps")), "campus-maps");
  assert.equal(
    collectionSlugFromId(buildCollectionId(BASE, "campus-maps", "published")),
    "campus-maps",
  );
  assert.equal(collectionSlugFromId(`${BASE}/presentation/manifest/abc/manifest.json`), null);
  assert.equal(collectionSlugFromId("campus-maps"), null);
  assert.equal(collectionSlugFromId(""), null);
  assert.equal(collectionSlugFromId(undefined), null);
});

test("normalizeContext: the presentation context, last and exactly once", () => {
  assert.equal(normalizeContext(PRESENTATION_CONTEXT), PRESENTATION_CONTEXT);
  assert.equal(normalizeContext(null), PRESENTATION_CONTEXT);

  // A foreign extension context survives, ahead of the presentation context.
  const navPlace = "http://iiif.io/api/extension/navplace/context.json";
  const mixed = normalizeContext([navPlace, PRESENTATION_CONTEXT]);
  assert.deepEqual(mixed, [navPlace, PRESENTATION_CONTEXT]);
  assert.equal(mixed.at(-1), PRESENTATION_CONTEXT);
  assert.deepEqual(normalizeContext(mixed), mixed, "idempotent");

  // WE ADD NOTHING. Our extension terms are absolute IRIs, so nothing has to be
  // declared — and an object in @context is what broke Clover, which maps over
  // the array calling .replace() on every entry.
  assert.equal(typeof normalizeContext(PRESENTATION_CONTEXT), "string");
  assert.equal(
    [PRESENTATION_CONTEXT, null, [navPlace, PRESENTATION_CONTEXT]]
      .flatMap((input) => [normalizeContext(input)].flat())
      .some((entry) => typeof entry !== "string"),
    false,
  );

  // A prefix declaration left by the old shape, or by another deployment, is
  // shed rather than carried forward — so a manifest written before this heals
  // the next time it is saved.
  const legacy = [{[STATIC_IIIF_PREFIX]: STATIC_IIIF_NAMESPACE}, PRESENTATION_CONTEXT];
  assert.equal(normalizeContext(legacy), PRESENTATION_CONTEXT);
  const theirs = [{[STATIC_IIIF_PREFIX]: "https://elsewhere.example/ns#"}, PRESENTATION_CONTEXT];
  assert.equal(normalizeContext(theirs), PRESENTATION_CONTEXT);
});

// The bug this shape exists to avoid. Clover normalizes http->https across
// @context by calling .replace() on each entry, guarding only against null, so
// an inline term-definition object throws "r.replace is not a function" and the
// viewer never renders. Canopy uses Clover, so this would break consumers of
// anything we publish, not only this app's own preview.
test("every @context we emit survives Clover's normalization", () => {
  const cloverNormalize = (doc) =>
    (Array.isArray(doc["@context"]) ? doc["@context"] : [doc["@context"]]).map((entry) =>
      entry == null ? undefined : entry.replace("http://", "https://"),
    );

  const filed = applyCollections(
    {"@context": PRESENTATION_CONTEXT, id: "m", type: "Manifest", items: []},
    {baseUrl: BASE, collections: [{slug: "campus-maps", label: "Campus Maps"}]},
  );
  assert.doesNotThrow(() => cloverNormalize(filed));

  const leaf = buildCollectionDocument({
    baseUrl: BASE,
    slug: "campus-maps",
    label: "Campus Maps",
    members: [{manifestId: `${BASE}/working/presentation/manifest/a/manifest.json`, label: "A"}],
  });
  assert.doesNotThrow(() => cloverNormalize(leaf));

  const root = buildRootCollectionDocument({
    baseUrl: BASE,
    collections: [{slug: "campus-maps", label: "Campus Maps", itemCount: 12}],
  });
  assert.doesNotThrow(() => cloverNormalize(root));
});

test("isManagedPartOfEntry: ours, theirs, and the cross-deployment trap", () => {
  const ours = buildPartOfEntry({baseUrl: BASE, slug: "campus-maps", label: "Campus Maps"});
  assert.equal(isManagedPartOfEntry(ours, {baseUrl: BASE}), true);

  // No marker, but the id is under our collection path — survives a hand-edit.
  const unmarked = {id: buildCollectionId(BASE, "campus-maps"), type: "Collection"};
  assert.equal(isManagedPartOfEntry(unmarked, {baseUrl: BASE}), true);

  // THE important case: another static-iiif deployment's manifest arrives with a
  // genuine marker pointing at a bucket we do not own. Claiming it would make us
  // invent leaf documents for slugs nobody here asked for.
  const foreignManaged = {
    id: "https://someone-else-iiif.s3.amazonaws.com/presentation/collection/campus-maps/collection.json",
    type: "Collection",
    [MANAGED_KEY]: true,
  };
  assert.equal(isManagedPartOfEntry(foreignManaged, {baseUrl: BASE}), false);

  // The real Northwestern entry from the fixture.
  assert.equal(isManagedPartOfEntry(nulManifest.partOf[0], {baseUrl: BASE}), false);

  // An id that merely contains our host but is not a collection document.
  assert.equal(
    isManagedPartOfEntry({id: `${BASE}/presentation/manifest/abc/manifest.json`}, {baseUrl: BASE}),
    false,
  );

  for (const junk of [null, undefined, "a string", {}, {id: 42}, []]) {
    assert.equal(isManagedPartOfEntry(junk, {baseUrl: BASE}), false, JSON.stringify(junk));
  }
});

test("managedCollectionRefs / foreignPartOfEntries split the array", () => {
  const partOf = [
    nulManifest.partOf[0],
    buildPartOfEntry({baseUrl: BASE, slug: "campus-maps", label: "Campus Maps"}),
  ];
  assert.deepEqual(managedCollectionRefs(partOf, {baseUrl: BASE}), [
    {slug: "campus-maps", label: "Campus Maps", id: buildCollectionId(BASE, "campus-maps")},
  ]);
  assert.deepEqual(foreignPartOfEntries(partOf, {baseUrl: BASE}), [nulManifest.partOf[0]]);
  assert.deepEqual(managedCollectionRefs(undefined, {baseUrl: BASE}), []);
});

test("stripForeignManagedEntries drops another deployment's claims on import", () => {
  const manifest = {
    "@context": [{[STATIC_IIIF_PREFIX]: "https://elsewhere.example/ns#"}, PRESENTATION_CONTEXT],
    partOf: [
      nulManifest.partOf[0],
      {
        id: "https://someone-else-iiif.s3.amazonaws.com/presentation/collection/x/collection.json",
        type: "Collection",
        [MANAGED_KEY]: true,
      },
    ],
  };
  const cleaned = stripForeignManagedEntries(manifest, {baseUrl: BASE});
  assert.deepEqual(cleaned.partOf, [nulManifest.partOf[0]]);
  assert.equal(cleaned["@context"], PRESENTATION_CONTEXT);

  // Nothing to strip: returns the manifest untouched, by identity.
  const clean = {partOf: [nulManifest.partOf[0]]};
  assert.equal(stripForeignManagedEntries(clean, {baseUrl: BASE}), clean);
});

test("applyCollections: foreign entries preserved verbatim at the front", () => {
  const next = applyCollections(nulManifest, {
    baseUrl: BASE,
    collections: [
      {slug: "campus-maps", label: "Campus Maps"},
      {slug: "annual-reports", label: "Annual Reports"},
    ],
  });

  assert.deepEqual(next.partOf[0], nulManifest.partOf[0]);
  // Ours sort by slug, so serialization is deterministic.
  assert.deepEqual(next.partOf.slice(1).map((e) => collectionSlugFromId(e.id)), [
    "annual-reports",
    "campus-maps",
  ]);
  assert.ok(next.partOf.slice(1).every((e) => e[MANAGED_KEY] === true));
  // Nothing is added: the marker key is an absolute IRI, so no prefix has to
  // be declared and @context stays the bare string a consumer can read.
  assert.equal(next["@context"], PRESENTATION_CONTEXT);
  // The source manifest is not mutated.
  assert.equal(nulManifest.partOf.length, 1);
});

test("applyCollections: input order does not affect output", () => {
  const a = applyCollections(nulManifest, {
    baseUrl: BASE,
    collections: [
      {slug: "campus-maps", label: "Campus Maps"},
      {slug: "annual-reports", label: "Annual Reports"},
    ],
  });
  const b = applyCollections(nulManifest, {
    baseUrl: BASE,
    collections: [
      {slug: "annual-reports", label: "Annual Reports"},
      {slug: "campus-maps", label: "Campus Maps"},
    ],
  });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("applyCollections: emptying unsets partOf rather than writing []", () => {
  const bare = {"@context": PRESENTATION_CONTEXT, id: "m", type: "Manifest", items: []};
  const added = applyCollections(bare, {
    baseUrl: BASE,
    collections: [{slug: "campus-maps", label: "Campus Maps"}],
  });
  const removed = applyCollections(added, {baseUrl: BASE, collections: []});

  assert.ok(!("partOf" in removed), "partOf key should be deleted, not []");
  assert.equal(removed["@context"], PRESENTATION_CONTEXT);
  assert.equal(JSON.stringify(removed), JSON.stringify(bare));
});

test("applyCollections: applying the same set twice is byte-identical", () => {
  const collections = [{slug: "campus-maps", label: "Campus Maps"}];
  const once = applyCollections(nulManifest, {baseUrl: BASE, collections});
  const twice = applyCollections(once, {baseUrl: BASE, collections});
  assert.equal(JSON.stringify(twice), JSON.stringify(once));
});

test("buildCollectionDocument satisfies the required Collection properties", () => {
  const document = buildCollectionDocument({
    baseUrl: BASE,
    slug: "campus-maps",
    label: "Campus Maps",
    members: [
      {manifestId: `${BASE}/presentation/manifest/a/manifest.json`, label: "A", thumbnail: null},
      {
        manifestId: `${BASE}/presentation/manifest/b/manifest.json`,
        label: "B",
        thumbnail: [{id: "https://img/1", type: "Image"}],
      },
    ],
  });

  for (const key of ["id", "type", "label", "items"]) {
    assert.ok(key in document, `Collection must have ${key}`);
  }
  assert.equal(document.type, "Collection");
  assert.equal(document["@context"], PRESENTATION_CONTEXT, "leaf carries no prefixed term");
  // Borrows the first member that actually has one.
  assert.deepEqual(document.thumbnail, [{id: "https://img/1", type: "Image"}]);
  assert.equal(document.partOf[0].id, buildCollectionId(BASE, ROOT_COLLECTION_SLUG));

  for (const item of document.items) {
    for (const key of ["id", "type", "label"]) {
      assert.ok(key in item, `reference must have ${key}`);
    }
    assert.equal(item.type, "Manifest");
  }
});

test("the root always exists, may be empty, and carries the count both ways", () => {
  const empty = createRootCollectionTemplate({baseUrl: BASE});
  assert.deepEqual(empty.items, [], "an empty items array is spec-legal");
  assert.equal(empty["@context"], PRESENTATION_CONTEXT);
  assert.equal(empty.type, "Collection");

  const root = buildRootCollectionDocument({
    baseUrl: BASE,
    collections: [
      {slug: "campus-maps", label: "Campus Maps", thumbnail: [{id: "https://img/1", type: "Image"}], itemCount: 12},
    ],
  });
  assert.equal(root["@context"], PRESENTATION_CONTEXT);

  const [entry] = root.items;
  assert.equal(entry.type, "Collection");
  assert.equal(entry[ITEM_COUNT_KEY], 12);
  assert.deepEqual(entry.metadata, [
    {label: {none: ["Items"]}, value: {none: ["12"]}},
  ]);

  // Round-trips through the read path.
  assert.deepEqual(rootCollectionSummaries(root), [
    {
      slug: "campus-maps",
      label: "Campus Maps",
      id: buildCollectionId(BASE, "campus-maps"),
      itemCount: 12,
      thumbnail: [{id: "https://img/1", type: "Image"}],
    },
  ]);
  assert.deepEqual(rootCollectionSummaries(empty), []);
});

test("rootCollectionSummaries falls back to the metadata count", () => {
  const entry = {
    id: buildCollectionId(BASE, "campus-maps"),
    type: "Collection",
    label: {none: ["Campus Maps"]},
    metadata: [{label: {none: ["Items"]}, value: {none: ["7"]}}],
  };
  assert.equal(rootCollectionSummaries({items: [entry]})[0].itemCount, 7);

  const {metadata, ...noCount} = entry;
  assert.equal(rootCollectionSummaries({items: [noCount]})[0].itemCount, null);
});
