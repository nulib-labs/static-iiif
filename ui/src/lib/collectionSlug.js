// Suggests a collection id from its name.
//
// Deliberately a CLIENT-side convenience and nothing more. The API validates the
// id it is handed and never derives one, because the moment a slug is computed
// from a label the label becomes identity — which is what used to make a
// collection impossible to name in any non-Latin script, and what made renaming
// one impossible.
//
// So this is allowed to return "": a name with no ASCII letters or digits in it
// has nothing to suggest from. That is not an error, it just means the curator
// types the id themselves.
const MAX_SLUG_LENGTH = 96;

export function suggestCollectionSlug(label) {
  return String(label ?? "")
    // NFKD splits accented characters into base + combining mark, so stripping
    // the marks turns "Café" into "cafe" rather than "caf".
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
}

// Mirrors sanitizeCollectionSlug in app/shared/collection.js. Duplicated rather
// than shared because the UI is a separate package with no path into app/ —
// worth knowing that the two have to move together.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = new Set(["index"]);

export function collectionSlugError(slug) {
  if (!slug) return "An id is required";
  if (!SLUG_PATTERN.test(slug)) {
    return "Only lowercase letters, numbers and single dashes";
  }
  if (slug.length > MAX_SLUG_LENGTH) return `At most ${MAX_SLUG_LENGTH} characters`;
  if (RESERVED.has(slug)) return `"${slug}" is reserved`;
  return null;
}

// The collection document's URL, built from the root's — which the collections
// list already returns, so this needs no extra configuration. Shown before the
// id is confirmed, because the id is permanent and public and that should be
// visible at the moment it is chosen rather than discovered afterwards.
export function previewCollectionUrl(rootId, slug) {
  if (!rootId || !slug) return null;
  return rootId.replace(/\/index\/collection\.json$/, `/${slug}/collection.json`);
}
