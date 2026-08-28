const {GetObjectCommand, ListObjectsV2Command} = require("@aws-sdk/client-s3");

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

function manifestSummary(identifier, manifest) {
  const label = manifest?.label?.none?.[0] || "";
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  return {
    identifier,
    label,
    manifestUrl: manifest?.id || "",
    relativePath: manifestObjectKey(identifier),
    itemCount: items.length,
    thumbnails: items.map(canvasThumbnailService).filter(Boolean),
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
  createManifestTemplate,
  readManifest,
  canvasThumbnailService,
  manifestSummary,
  listManifestSummaries,
};
