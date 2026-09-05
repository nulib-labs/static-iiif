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
  mergeContext,
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
  assert.equal(collectionObjectKey("campus-maps"), "presentation/collection/campus-maps/collection.json");
  // The root must be buildable even though its slug is reserved for users.
  assert.equal(rootCollectionKey(), "presentation/collection/index/collection.json");

  assert.equal(buildCollectionId(BASE, "campus-maps"), `${BASE}/presentation/collection/campus-maps/collection.json`);
  assert.equal(buildCollectionId(`${BASE}/`, "campus-maps"), buildCollectionId(BASE, "campus-maps"));
  assert.equal(buildCollectionId("", "campus-maps"), "presentation/collection/campus-maps/collection.json");

  assert.equal(collectionSlugFromId(buildCollectionId(BASE, "campus-maps")), "campus-maps");
  assert.equal(collectionSlugFromId(`${BASE}/presentation/manifest/abc/manifest.json`), null);
  assert.equal(collectionSlugFromId("campus-maps"), null);
  assert.equal(collectionSlugFromId(""), null);
  assert.equal(collectionSlugFromId(undefined), null);
});

test("mergeContext: presentation context is always last, exactly once", () => {
  assert.equal(mergeContext(PRESENTATION_CONTEXT, {managed: false}), PRESENTATION_CONTEXT);
  assert.equal(mergeContext(null, {managed: false}), PRESENTATION_CONTEXT);

  const managed = mergeContext(PRESENTATION_CONTEXT, {managed: true});
  assert.deepEqual(managed, [{[STATIC_IIIF_PREFIX]: STATIC_IIIF_NAMESPACE}, PRESENTATION_CONTEXT]);
  assert.equal(managed.at(-1), PRESENTATION_CONTEXT);

  // Unmanaging collapses back to the bare string.
  assert.equal(mergeContext(managed, {managed: false}), PRESENTATION_CONTEXT);

  // A foreign extension context survives, ahead of the presentation context.
  const navPlace = "http://iiif.io/api/extension/navplace/context.json";
  const mixed = mergeContext([navPlace, PRESENTATION_CONTEXT], {managed: true});
  assert.deepEqual(mixed, [navPlace, {[STATIC_IIIF_PREFIX]: STATIC_IIIF_NAMESPACE}, PRESENTATION_CONTEXT]);

  // Idempotent, and never duplicates our prefix object.
  assert.deepEqual(mergeContext(mixed, {managed: true}), mixed);

  // Another deployment's namespace for the same prefix is replaced, not kept.
  const theirs = [{[STATIC_IIIF_PREFIX]: "https://elsewhere.example/ns#"}, PRESENTATION_CONTEXT];
  assert.deepEqual(mergeContext(theirs, {managed: true}), [
    {[STATIC_IIIF_PREFIX]: STATIC_IIIF_NAMESPACE},
    PRESENTATION_CONTEXT,
  ]);
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
  assert.deepEqual(next["@context"], [
    {[STATIC_IIIF_PREFIX]: STATIC_IIIF_NAMESPACE},
    PRESENTATION_CONTEXT,
  ]);
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
  assert.deepEqual(root["@context"], [
    {[STATIC_IIIF_PREFIX]: STATIC_IIIF_NAMESPACE},
    PRESENTATION_CONTEXT,
  ]);

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
