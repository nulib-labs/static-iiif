const {GetObjectCommand, ListObjectsV2Command} = require("@aws-sdk/client-s3");
// Re-exported below so existing importers keep working.
const {extractLabel} = require("./language");

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

function buildManifestId(baseUrl, identifier) {
  const normalizedBase = (baseUrl || "").replace(/\/$/, "");
  const manifestKey = manifestObjectKey(identifier);
  return normalizedBase ? `${normalizedBase}/${manifestKey}` : manifestKey;
}

function createManifestTemplate({baseUrl, identifier, label}) {
  return {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id: buildManifestId(baseUrl, identifier),
    type: "Manifest",
    label: {
      none: [label],
    },
    items: [],
  };
}

async function streamToString(body) {
  if (typeof body === "string") return body;
  if (body && typeof body.transformToString === "function") {
    return body.transformToString();
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    body
      .on("data", (chunk) => chunks.push(chunk))
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function readManifest({s3, bucket, identifier}) {
  const key = manifestObjectKey(identifier);
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
  const payload = await streamToString(response.Body);
  return JSON.parse(payload);
}

function canvasThumbnailService(canvas) {
  const service = canvas?.items?.[0]?.items?.[0]?.body?.service?.[0];
  return service?.id || null;
}

// A projection, not the raw array: an imported manifest's partOf carries the
// source institution's summary, which can run to a paragraph, and GET /manifests
// returns every manifest in one response under a 6MB cap. id/type/label plus any
// prefixed extension terms is all a caller needs. The generic ":" test keeps this
// module free of any collection import.
function partOfRefs(manifest) {
  const entries = Array.isArray(manifest?.partOf) ? manifest.partOf : [];
  return entries.filter(Boolean).map((entry) => {
    const ref = {id: entry.id, type: entry.type, label: entry.label};
    for (const key of Object.keys(entry)) {
      if (key.includes(":")) ref[key] = entry[key];
    }
    return ref;
  });
}

function manifestSummary(identifier, manifest) {
  const label = extractLabel(manifest?.label);
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  return {
    identifier,
    label,
    manifestUrl: manifest?.id || "",
    relativePath: manifestObjectKey(identifier),
    itemCount: items.length,
    thumbnails: items.map(canvasThumbnailService).filter(Boolean),
    partOf: partOfRefs(manifest),
  };
}

async function listManifestSummaries({s3, bucket}) {
  const manifests = [];
  let continuationToken;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${MANIFEST_PREFIX}/`,
        ContinuationToken: continuationToken,
      }),
    );
    const manifestObjects = (response.Contents || []).filter((item) =>
      item.Key.endsWith(`/${MANIFEST_OBJECT}`),
    );
    await Promise.all(
      manifestObjects.map(async (object) => {
        const identifier = object.Key.split("/")[2];
        try {
          const manifest = await readManifest({s3, bucket, identifier});
          manifests.push(manifestSummary(identifier, manifest));
        } catch (error) {
          console.error(`Failed to read manifest ${object.Key}:`, error);
        }
      }),
    );
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return manifests.sort(
    (a, b) => a.label.localeCompare(b.label) || a.identifier.localeCompare(b.identifier),
  );
}

module.exports = {
  MANIFEST_PREFIX,
  MANIFEST_OBJECT,
  manifestIdPattern,
  sanitizeManifestIdentifier,
  manifestObjectKey,
  buildManifestId,
  createManifestTemplate,
  extractLabel,
  readManifest,
  canvasThumbnailService,
  manifestSummary,
  partOfRefs,
  listManifestSummaries,
};
