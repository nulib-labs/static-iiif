// Copy of app/shared/manifest.js — keep in sync with the source.
const MANIFEST_PREFIX = "presentation/manifest";
const MANIFEST_OBJECT = "manifest.json";
const manifestIdPattern = /^[A-Za-z0-9._-]+$/;

function sanitizeManifestIdentifier(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    throw new Error("Manifest id is required");
  }
  if (!manifestIdPattern.test(trimmed)) {
    throw new Error(
      "Manifest id may only include letters, numbers, periods, underscores, or dashes",
    );
  }
  if (trimmed.includes("..")) {
    throw new Error("Manifest id cannot contain parent directory references");
  }
  return trimmed;
}

function manifestObjectKey(identifier) {
  const normalized = sanitizeManifestIdentifier(identifier);
  return `${MANIFEST_PREFIX}/${normalized}/${MANIFEST_OBJECT}`;
}

function createManifestTemplate({baseUrl, identifier, label}) {
  const normalizedBase = (baseUrl || "").replace(/\/$/, "");
  const manifestKey = manifestObjectKey(identifier);
  const manifestId = normalizedBase ? `${normalizedBase}/${manifestKey}` : manifestKey;
  return {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id: manifestId,
    type: "Manifest",
    label: {
      none: [label],
    },
    items: [],
  };
}

module.exports = {
  MANIFEST_PREFIX,
  MANIFEST_OBJECT,
  manifestIdPattern,
  sanitizeManifestIdentifier,
  manifestObjectKey,
  createManifestTemplate,
};
