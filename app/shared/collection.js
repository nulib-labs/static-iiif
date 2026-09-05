// IIIF Presentation 3.0 Collections.
//
// Membership is authoritative in each manifest's `partOf`; the collection
// documents under `presentation/collection/` are a derived projection that can
// be rebuilt from the manifests alone. Everything in this module is pure — the
// IO lives in `app/aws/lambdas/manifest/collections.js`.
//
// Deliberately depends on nothing but ./language: manifest.js loads the AWS SDK
// at module scope, and pulling that in would make these pure functions
// untestable without it.
const {languageMap, extractLabel} = require("./language");

const COLLECTION_PREFIX = "presentation/collection";
const COLLECTION_OBJECT = "collection.json";

// The collection of collections. Always exists, even with no members, and is
// the only slug a user may not claim.
const ROOT_COLLECTION_SLUG = "index";
const ROOT_COLLECTION_LABEL = "All Collections";

const PRESENTATION_CONTEXT = "http://iiif.io/api/presentation/3/context.json";

// A registered-extension-style namespace, per the IIIF extension guidance. The
// trailing "#" is load-bearing: under JSON-LD 1.1 a simple term definition is
// only usable as a compact-IRI prefix when its value ends in a gen-delim, so
// dropping it would make `staticiiif:managed` silently fail to expand.
const STATIC_IIIF_PREFIX = "staticiiif";
const STATIC_IIIF_NAMESPACE = "https://nulib-labs.github.io/static-iiif/ns#";
const MANAGED_KEY = `${STATIC_IIIF_PREFIX}:managed`;
const ITEM_COUNT_KEY = `${STATIC_IIIF_PREFIX}:itemCount`;

const MAX_LABEL_LENGTH = 200;
const MAX_SLUG_LENGTH = 96;
const MAX_COLLECTIONS_PER_WORK = 32;

const collectionSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const collectionIdPattern = /\/presentation\/collection\/([a-z0-9-]+)\/collection\.json$/;

class CollectionNameError extends Error {}

// "Environmental Impact Statements" -> "environmental-impact-statements".
//
// The slug IS the collection's identity: two labels that reduce to the same
// slug are the same collection, which is what lets the autocomplete forgive
// case, punctuation and stray whitespace. Idempotent, so it is safe to run over
// a value that is already a slug.
function slugifyCollectionLabel(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new CollectionNameError("A collection name is required");
  }
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new CollectionNameError(
      `Collection names are limited to ${MAX_LABEL_LENGTH} characters`,
    );
  }

  let slug = trimmed
    // NFKD splits accented characters into base + combining mark, so stripping
    // the marks turns "Café" into "cafe" rather than "caf".
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH);
    const lastDash = slug.lastIndexOf("-");
    if (lastDash > 0) {
      slug = slug.slice(0, lastDash);
    }
    slug = slug.replace(/-+$/, "");
  }

  if (!slug) {
    throw new CollectionNameError(
      `"${trimmed}" doesn't contain any letters or numbers to build a collection name from`,
    );
  }
  if (slug === ROOT_COLLECTION_SLUG) {
    throw new CollectionNameError(
      `"${trimmed}" is a reserved collection name — please choose another`,
    );
  }
  return slug;
}

// Validates a value that is already a slug without transforming it. Used when
// reading slugs back out of stored ids, where a silent rewrite would mask
// corruption rather than surface it.
function sanitizeCollectionSlug(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new CollectionNameError("A collection id is required");
  }
  if (!collectionSlugPattern.test(trimmed)) {
    throw new CollectionNameError(
      "Collection ids may only include lowercase letters, numbers, and single dashes",
    );
  }
  if (trimmed === ROOT_COLLECTION_SLUG) {
    throw new CollectionNameError(`"${trimmed}" is a reserved collection name`);
  }
  return trimmed;
}

// Deliberately does not run the reserved-slug check, so rootCollectionKey can
// call through it.
function collectionObjectKey(slug) {
  return `${COLLECTION_PREFIX}/${slug}/${COLLECTION_OBJECT}`;
}

function rootCollectionKey() {
  return collectionObjectKey(ROOT_COLLECTION_SLUG);
}

function buildCollectionId(baseUrl, slug) {
  const normalizedBase = (baseUrl || "").replace(/\/$/, "");
  const key = collectionObjectKey(slug);
  return normalizedBase ? `${normalizedBase}/${key}` : key;
}

function buildRootCollectionId(baseUrl) {
  return buildCollectionId(baseUrl, ROOT_COLLECTION_SLUG);
}

function collectionSlugFromId(id) {
  const match = collectionIdPattern.exec(typeof id === "string" ? id : "");
  return match ? match[1] : null;
}

// Presentation 3.0: the value must be the presentation context URI, or an array
// with it as the LAST item, with extension contexts added before it. Our prefix
// object sits last among the extensions so its term definition cannot be
// shadowed by a foreign context the manifest arrived with.
function mergeContext(existing, {managed}) {
  const entries = Array.isArray(existing) ? existing : existing ? [existing] : [];
  const foreign = entries.filter((entry) => {
    if (entry === PRESENTATION_CONTEXT) return false;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const keys = Object.keys(entry);
      // Drop any prior staticiiif prefix definition — ours is re-added below,
      // and this also sheds the namespace of another deployment we imported from.
      return !(keys.length === 1 && keys[0] === STATIC_IIIF_PREFIX);
    }
    return true;
  });

  const next = [...foreign];
  if (managed) {
    next.push({[STATIC_IIIF_PREFIX]: STATIC_IIIF_NAMESPACE});
  }
  next.push(PRESENTATION_CONTEXT);
  // Collapse back to the bare string when nothing else is present, so an
  // unmanaged manifest stays byte-identical to createManifestTemplate's output.
  return next.length === 1 ? PRESENTATION_CONTEXT : next;
}

function buildPartOfEntry({baseUrl, slug, label}) {
  return {
    id: buildCollectionId(baseUrl, slug),
    type: "Collection",
    label: languageMap(label),
    [MANAGED_KEY]: true,
  };
}

// Is this partOf entry one of ours?
//
// Two independent signals, because each fails alone: the marker is lost to a
// hand-edit, and the path check breaks the day IIIF_BASE_URL moves to a custom
// domain. The baseUrl clause is what stops us claiming a collection belonging to
// *another* static-iiif deployment whose manifest we imported — those arrive
// carrying a genuine marker pointing at a bucket we do not own.
function isManagedPartOfEntry(entry, {baseUrl} = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const id = typeof entry.id === "string" ? entry.id : "";
  if (entry[MANAGED_KEY] !== true && !collectionIdPattern.test(id)) return false;

  const normalizedBase = (baseUrl || "").replace(/\/$/, "");
  if (!normalizedBase) return true;
  return id.startsWith(`${normalizedBase}/`);
}

function partOfEntries(partOf) {
  return Array.isArray(partOf) ? partOf.filter(Boolean) : [];
}

// Our entries, in document order, as {slug, label, id}.
function managedCollectionRefs(partOf, {baseUrl} = {}) {
  return partOfEntries(partOf)
    .filter((entry) => isManagedPartOfEntry(entry, {baseUrl}))
    .map((entry) => ({
      slug: collectionSlugFromId(entry.id),
      label: extractLabel(entry.label),
      id: entry.id,
    }))
    .filter((ref) => Boolean(ref.slug));
}

// Everything that is not ours — an imported manifest's link back to the source
// institution's collection, which we preserve verbatim.
function foreignPartOfEntries(partOf, {baseUrl} = {}) {
  return partOfEntries(partOf).filter((entry) => !isManagedPartOfEntry(entry, {baseUrl}));
}

// On import, drop entries that carry our marker but point somewhere we do not
// own. Without this, importing from another static-iiif deployment injects
// membership in collections nobody here asked for.
function stripForeignManagedEntries(manifest, {baseUrl}) {
  const entries = partOfEntries(manifest?.partOf);
  const kept = entries.filter(
    (entry) => !isManagedPartOfEntry(entry, {}) || isManagedPartOfEntry(entry, {baseUrl}),
  );
  if (kept.length === entries.length) return manifest;

  const next = {...manifest};
  if (kept.length) {
    next.partOf = kept;
  } else {
    delete next.partOf;
  }
  next["@context"] = mergeContext(manifest?.["@context"], {
    managed: kept.some((entry) => isManagedPartOfEntry(entry, {baseUrl})),
  });
  return next;
}

// Rewrite a manifest's managed membership, leaving foreign entries untouched at
// the front. Ours are sorted by slug so the document serializes deterministically
// — read-compare-write depends on that to elide no-op writes.
function applyCollections(manifest, {baseUrl, collections}) {
  const next = {...manifest};
  const foreign = foreignPartOfEntries(manifest?.partOf, {baseUrl});
  const ours = [...(collections || [])]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map(({slug, label}) => buildPartOfEntry({baseUrl, slug, label}));

  const partOf = [...foreign, ...ours];
  if (partOf.length) {
    next.partOf = partOf;
  } else {
    // The spec describes partOf as having "at least one item", so unset the key
    // rather than writing an empty array.
    delete next.partOf;
  }
  next["@context"] = mergeContext(manifest?.["@context"], {managed: ours.length > 0});
  return next;
}

function buildManifestReference({manifestId, label, thumbnail}) {
  const reference = {
    id: manifestId,
    type: "Manifest",
    label: languageMap(label),
  };
  if (thumbnail && thumbnail.length) {
    reference.thumbnail = thumbnail;
  }
  return reference;
}

// An entry in the root collection. Carries the item count twice on purpose:
// `metadata` is the only display-legal slot Presentation 3.0 offers, but reading
// "12" back out of a language map keyed on the English word "Items" is fragile,
// and clients that merge references with the dereferenced document by id would
// drop it entirely (the leaf carries no metadata). The prefixed term is what our
// own API reads.
function buildCollectionReference({baseUrl, slug, label, thumbnail, itemCount}) {
  const reference = {
    id: buildCollectionId(baseUrl, slug),
    type: "Collection",
    label: languageMap(label),
  };
  if (thumbnail && thumbnail.length) {
    reference.thumbnail = thumbnail;
  }
  reference.metadata = [
    {label: languageMap("Items"), value: languageMap(String(itemCount))},
  ];
  reference[ITEM_COUNT_KEY] = itemCount;
  return reference;
}

function buildCollectionDocument({baseUrl, slug, label, members}) {
  const items = members.map(buildManifestReference);
  const thumbnail = members.find((member) => member.thumbnail?.length)?.thumbnail;

  const document = {
    // The leaf carries no prefixed term, so it needs no extension prefix.
    "@context": PRESENTATION_CONTEXT,
    id: buildCollectionId(baseUrl, slug),
    type: "Collection",
    label: languageMap(label),
  };
  if (thumbnail) {
    document.thumbnail = thumbnail;
  }
  document.partOf = [
    {
      id: buildRootCollectionId(baseUrl),
      type: "Collection",
      label: languageMap(ROOT_COLLECTION_LABEL),
    },
  ];
  document.items = items;
  return document;
}

// `items: []` is explicitly permitted by the spec ("allowed but discouraged"),
// which is what lets the root exist before any collection does.
function buildRootCollectionDocument({baseUrl, collections}) {
  const items = collections.map((collection) =>
    buildCollectionReference({baseUrl, ...collection}),
  );
  return {
    "@context": mergeContext(null, {managed: items.length > 0}),
    id: buildRootCollectionId(baseUrl),
    type: "Collection",
    label: languageMap(ROOT_COLLECTION_LABEL),
    items,
  };
}

function createRootCollectionTemplate({baseUrl}) {
  return buildRootCollectionDocument({baseUrl, collections: []});
}

// Flatten a stored root document into the shape GET /collections returns.
function rootCollectionSummaries(root) {
  return partOfEntries(root?.items)
    .map((entry) => {
      const slug = collectionSlugFromId(entry.id);
      if (!slug) return null;
      return {
        slug,
        label: extractLabel(entry.label),
        id: entry.id,
        itemCount: readItemCount(entry),
        thumbnail: entry.thumbnail || null,
      };
    })
    .filter(Boolean);
}

function readItemCount(entry) {
  if (typeof entry?.[ITEM_COUNT_KEY] === "number") return entry[ITEM_COUNT_KEY];
  const metadata = Array.isArray(entry?.metadata) ? entry.metadata : [];
  for (const field of metadata) {
    if (extractLabel(field?.label) === "Items") {
      const parsed = Number.parseInt(extractLabel(field?.value), 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

// Canonical serialization. Reconciliation compares against it to skip writes
// that would change nothing, which is also what makes a retry after a partial
// failure repair the projection instead of short-circuiting.
const serializeCollection = (document) => JSON.stringify(document, null, 2);

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

function sortMembers(members) {
  return [...members].sort(
    (a, b) => extractLabel(a.label).localeCompare(extractLabel(b.label)) || String(a.id).localeCompare(String(b.id)),
  );
}

function membersOf(document) {
  return Array.isArray(document?.items) ? document.items.filter((item) => item && item.id) : [];
}

// A collection's name is set by whoever created it. A later curator typing
// "campus maps" joins the existing "Campus Maps" rather than renaming it — and
// that has to apply to the label cached in their manifest's own partOf too, or
// the work would display a name the collection does not actually have.
function canonicalizeCollectionLabels(desired, root) {
  const canonical = new Map(rootCollectionSummaries(root).map((entry) => [entry.slug, entry.label]));
  return (desired || []).map((entry) => ({
    ...entry,
    label: canonical.get(entry.slug) || entry.label,
  }));
}

// Rebuild every touched collection document, plus the root, from documents we
// already hold. A leaf document IS its own member list, so no corpus scan is
// needed on this path.
//
//   member  — {manifestId, label, thumbnail}. manifestId is always required:
//             it is how a work is found and dropped from a leaf's member list,
//             including on the delete path where there is nothing to re-add.
//   removed — the manifest itself is gone; drop it everywhere, add it nowhere
//   desired — the slugs the work should belong to, as [{slug, label}]
//   leaves  — {slug: document | null} for every slug in the union of the work's
//             current and desired membership. The UNION, never the diff: a diff
//             would short-circuit a retry after a partial failure and leave the
//             projection broken until the next reindex.
function planReconciliation({baseUrl, member, removed = false, desired, root, leaves}) {
  const desiredBySlug = new Map((desired || []).map((entry) => [entry.slug, entry]));
  // The root's existing label wins over a caller-supplied one, so a second
  // curator typing "campus maps" can't retitle a collection the first one named.
  const summaryBySlug = new Map(rootCollectionSummaries(root).map((entry) => [entry.slug, entry]));

  const leafWrites = [];
  const leafDeletes = [];

  // Sorted, so the plan is a function of its inputs' *values* and not of the
  // order the caller happened to build `leaves` in.
  for (const slug of Object.keys(leaves).sort()) {
    const existing = leaves[slug];
    const keep = membersOf(existing).filter((item) => item.id !== member.manifestId);
    if (!removed && desiredBySlug.has(slug)) {
      keep.push({
        id: member.manifestId,
        label: {none: [member.label]},
        ...(member.thumbnail?.length ? {thumbnail: member.thumbnail} : {}),
      });
    }

    if (!keep.length) {
      leafDeletes.push({slug, key: collectionObjectKey(slug)});
      summaryBySlug.delete(slug);
      continue;
    }

    const label = summaryBySlug.get(slug)?.label || desiredBySlug.get(slug)?.label || extractLabel(existing?.label) || slug;
    const members = sortMembers(keep).map((item) => ({
      manifestId: item.id,
      label: extractLabel(item.label),
      thumbnail: item.thumbnail || null,
    }));
    const document = buildCollectionDocument({baseUrl, slug, label, members});

    if (!existing || serializeCollection(existing) !== serializeCollection(document)) {
      leafWrites.push({slug, key: collectionObjectKey(slug), document});
    }
    summaryBySlug.set(slug, {
      slug,
      label,
      thumbnail: document.thumbnail || null,
      itemCount: members.length,
    });
  }

  const collections = [...summaryBySlug.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.slug.localeCompare(b.slug),
  );
  const rootNext = buildRootCollectionDocument({baseUrl, collections});
  const rootChanged = !root || serializeCollection(root) !== serializeCollection(rootNext);

  return {leafWrites, leafDeletes, rootNext, rootChanged, collections};
}

function manifestThumbnail(manifest) {
  if (Array.isArray(manifest?.thumbnail) && manifest.thumbnail.length) return manifest.thumbnail;
  const canvasThumbnail = manifest?.items?.[0]?.thumbnail;
  return Array.isArray(canvasThumbnail) && canvasThumbnail.length ? canvasThumbnail : null;
}

module.exports = {
  COLLECTION_PREFIX,
  COLLECTION_OBJECT,
  ROOT_COLLECTION_SLUG,
  ROOT_COLLECTION_LABEL,
  PRESENTATION_CONTEXT,
  STATIC_IIIF_PREFIX,
  STATIC_IIIF_NAMESPACE,
  MANAGED_KEY,
  ITEM_COUNT_KEY,
  MAX_LABEL_LENGTH,
  MAX_SLUG_LENGTH,
  MAX_COLLECTIONS_PER_WORK,
  collectionSlugPattern,
  CollectionNameError,
  slugifyCollectionLabel,
  sanitizeCollectionSlug,
  collectionObjectKey,
  rootCollectionKey,
  buildCollectionId,
  buildRootCollectionId,
  collectionSlugFromId,
  mergeContext,
  buildPartOfEntry,
  isManagedPartOfEntry,
  managedCollectionRefs,
  foreignPartOfEntries,
  stripForeignManagedEntries,
  applyCollections,
  buildManifestReference,
  buildCollectionReference,
  buildCollectionDocument,
  buildRootCollectionDocument,
  createRootCollectionTemplate,
  rootCollectionSummaries,
  serializeCollection,
  planReconciliation,
  canonicalizeCollectionLabels,
  manifestThumbnail,
};
