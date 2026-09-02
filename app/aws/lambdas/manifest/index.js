const crypto = require("node:crypto");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const {
  MANIFEST_PREFIX,
  sanitizeManifestIdentifier,
  manifestObjectKey,
  buildManifestId,
  createManifestTemplate,
  extractLabel,
  canvasThumbnailService,
  readManifest: readManifestShared,
  manifestSummary,
  listManifestSummaries: listManifestSummariesShared,
} = require("../../../shared/manifest");
const {
  triggerAssetImport,
  handleImportAssets,
  readImportStatus,
  resumeAssetImport,
  handleImportFailure,
} = require("./importAssets");

const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // stay comfortably under the 6MB Lambda payload cap

class ImportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateSourceUrl(raw) {
  const value = (raw || "").trim();
  if (!value) {
    throw new ImportError(400, "A manifest URL is required");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ImportError(400, "That doesn't look like a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ImportError(400, "Only http(s) URLs are supported");
  }
  return parsed.toString();
}

async function fetchExternalManifest(sourceUrl) {
  let response;
  try {
    response = await fetch(sourceUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new ImportError(502, `Unable to reach that URL: ${error.message}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new ImportError(
      400,
      "The URL returned a redirect — please paste the final manifest URL directly.",
    );
  }

  if (!response.ok) {
    throw new ImportError(400, `Source server returned ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength && contentLength > MAX_IMPORT_BYTES) {
    throw new ImportError(400, "Manifest is too large to import (max 5MB)");
  }

  const text = await response.text();
  if (text.length > MAX_IMPORT_BYTES) {
    throw new ImportError(400, "Manifest is too large to import (max 5MB)");
  }

  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new ImportError(400, "URL did not return valid JSON");
  }

  const type = manifest?.type || manifest?.["@type"];
  if (typeof type === "string" && type.toLowerCase().includes("collection")) {
    throw new ImportError(
      400,
      "Collection import isn't supported yet — paste a single Manifest URL.",
    );
  }
  if (type !== "Manifest") {
    throw new ImportError(
      400,
      "Only IIIF Presentation 3.0 Manifests are supported right now.",
    );
  }

  return manifest;
}

const s3 = new S3Client({});
const bucket = process.env.IIIF_BUCKET;
const sourceBucket = process.env.SOURCE_BUCKET;
const manifestBaseUrl = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");
const imageApiBase = (process.env.IMAGE_API_BASE_URL || "").replace(/\/$/, "");
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};
const SOURCE_IMAGE_EXTENSIONS = ["jpg", "jpeg", "tif", "tiff", "png", "webp"];

function keyFromImageServiceId(serviceId) {
  if (!serviceId || !imageApiBase || !serviceId.startsWith(`${imageApiBase}/`)) {
    return null;
  }
  try {
    return decodeURIComponent(serviceId.slice(imageApiBase.length + 1));
  } catch (error) {
    return null;
  }
}

async function deleteKeys(targetBucket, keys) {
  const uniqueKeys = [...new Set(keys)].filter(Boolean);
  for (let i = 0; i < uniqueKeys.length; i += 1000) {
    const batch = uniqueKeys.slice(i, i + 1000);
    if (batch.length === 0) continue;
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: targetBucket,
        Delete: {Objects: batch.map((Key) => ({Key}))},
      }),
    );
  }
}

async function deleteByPrefix(targetBucket, prefix) {
  let continuationToken;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({Bucket: targetBucket, Prefix: prefix, ContinuationToken: continuationToken}),
    );
    await deleteKeys(targetBucket, (response.Contents || []).map((object) => object.Key));
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
}

async function deleteManifestAssets(identifier, manifest) {
  const assetPrefix = `image/${identifier}/`;
  await Promise.all([deleteByPrefix(sourceBucket, assetPrefix), deleteByPrefix(bucket, assetPrefix)]);

  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  const extraSourceKeys = [];
  const extraIiifKeys = [];
  for (const canvas of items) {
    const serviceId = canvas?.items?.[0]?.items?.[0]?.body?.service?.[0]?.id;
    const keyWithoutExt = keyFromImageServiceId(serviceId);
    if (!keyWithoutExt || keyWithoutExt.startsWith(assetPrefix)) {
      continue; // already handled by the prefix delete above
    }
    extraIiifKeys.push(`${keyWithoutExt}.tif`);
    for (const ext of SOURCE_IMAGE_EXTENSIONS) {
      extraSourceKeys.push(`${keyWithoutExt}.${ext}`);
    }
  }
  await Promise.all([deleteKeys(sourceBucket, extraSourceKeys), deleteKeys(bucket, extraIiifKeys)]);
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
    body: JSON.stringify(payload),
  };
}

function manifestDetail(identifier, manifest) {
  return {
    ...manifestSummary(identifier, manifest),
    manifest,
  };
}

// Only these manifest-level fields may be written through the API. Everything
// else — id, type, @context, items, thumbnail — is owned by the server, so a
// request body can never reach them.
const EDITABLE_MANIFEST_FIELDS = ["label", "summary", "metadata", "behavior"];

// A IIIF language map: {"none": ["value", ...]} — every value an array of strings.
function isLanguageMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.values(value);
  if (entries.length === 0) return false;
  return entries.every(
    (entry) => Array.isArray(entry) && entry.every((item) => typeof item === "string"),
  );
}

function validateManifestField(field, value) {
  if (value === null) return null; // an explicit null unsets the field
  switch (field) {
    case "label":
    case "summary":
      return isLanguageMap(value) ? null : `${field} must be a language map`;
    case "metadata":
      if (!Array.isArray(value)) return "metadata must be an array";
      return value.every((entry) => entry && isLanguageMap(entry.label) && isLanguageMap(entry.value))
        ? null
        : "each metadata entry must have a label and value language map";
    case "behavior":
      return Array.isArray(value) && value.every((item) => typeof item === "string")
        ? null
        : "behavior must be an array of strings";
    default:
      return `${field} is not editable`;
  }
}

async function readManifest(identifier) {
  return readManifestShared({s3, bucket, identifier});
}

async function writeManifest(identifier, manifest) {
  const key = manifestObjectKey(identifier);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: "application/json",
    }),
  );
  return key;
}

async function listManifestSummaries() {
  return listManifestSummariesShared({s3, bucket});
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("Invalid JSON payload");
  }
}

exports.handler = async (event) => {
  if (event?.source === "lambda" && event?.detail?.requestContext?.condition) {
    return handleImportFailure(event.detail);
  }

  if (event?.action === "importAssets") {
    return handleImportAssets(event);
  }

  const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
  const rawPath = event?.rawPath || event?.path || "/";
  const segments = rawPath
    .split("/")
    .filter(Boolean);

  if (method === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }

  if (segments[0] !== "manifests") {
    return jsonResponse(404, { error: "Not found" });
  }

  if (segments.length === 1) {
    if (method === "GET") {
      try {
        const manifests = await listManifestSummaries();
        return jsonResponse(200, { manifests });
      } catch (error) {
        console.error("List manifests failed", error);
        return jsonResponse(500, { error: "Unable to list manifests" });
      }
    }

    if (method === "POST") {
      try {
        const body = parseBody(event);
        const label = (body.label || "").trim();
        if (!label) {
          return jsonResponse(400, { error: "Label is required" });
        }
        const identifier = crypto.randomUUID();
        const manifest = createManifestTemplate({ baseUrl: manifestBaseUrl, identifier, label });
        await writeManifest(identifier, manifest);
        return jsonResponse(201, { manifest: manifestDetail(identifier, manifest) });
      } catch (error) {
        if (error.message === "Invalid JSON payload") {
          return jsonResponse(400, { error: error.message });
        }
        console.error("Create manifest failed", error);
        return jsonResponse(500, { error: error.message });
      }
    }

    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (method === "POST" && segments.length === 3 && segments[1] === "import" && segments[2] === "preview") {
    try {
      const body = parseBody(event);
      const sourceUrl = validateSourceUrl(body.sourceUrl);
      const manifest = await fetchExternalManifest(sourceUrl);
      const label = extractLabel(manifest.label);
      const itemCount = Array.isArray(manifest.items) ? manifest.items.length : 0;
      const thumbnail = itemCount > 0 ? canvasThumbnailService(manifest.items[0]) : null;
      return jsonResponse(200, { label, itemCount, thumbnail, sourceUrl, manifest });
    } catch (error) {
      if (error.message === "Invalid JSON payload") {
        return jsonResponse(400, { error: error.message });
      }
      if (error instanceof ImportError) {
        return jsonResponse(error.status, { error: error.message });
      }
      console.error("Import preview failed", error);
      return jsonResponse(500, { error: "Unable to preview manifest" });
    }
  }

  if (method === "POST" && segments.length === 2 && segments[1] === "import") {
    try {
      const body = parseBody(event);
      const sourceUrl = validateSourceUrl(body.sourceUrl);
      const manifest = body.manifest;
      if (!manifest || typeof manifest !== "object" || manifest.type !== "Manifest") {
        return jsonResponse(400, { error: "A valid Manifest is required" });
      }
      const identifier = crypto.randomUUID();
      const importedManifest = {
        ...manifest,
        id: buildManifestId(manifestBaseUrl, identifier),
      };
      await writeManifest(identifier, importedManifest);
      try {
        await triggerAssetImport({identifier, total: importedManifest.items.length});
      } catch (error) {
        console.error("Failed to start asset import", error);
      }
      return jsonResponse(201, { manifest: manifestDetail(identifier, importedManifest) });
    } catch (error) {
      if (error.message === "Invalid JSON payload") {
        return jsonResponse(400, { error: error.message });
      }
      if (error instanceof ImportError) {
        return jsonResponse(error.status, { error: error.message });
      }
      console.error("Import manifest failed", error);
      return jsonResponse(500, { error: error.message });
    }
  }

  const rawIdentifier = decodeURIComponent(segments[1] || "");
  let identifier;
  try {
    identifier = sanitizeManifestIdentifier(rawIdentifier);
  } catch (error) {
    return jsonResponse(400, { error: error.message });
  }

  if (segments.length === 2) {
    if (method === "GET") {
      try {
        const manifest = await readManifest(identifier);
        return jsonResponse(200, { manifest: manifestDetail(identifier, manifest) });
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") {
          return jsonResponse(404, { error: "Manifest not found" });
        }
        console.error("Read manifest failed", error);
        return jsonResponse(500, { error: "Unable to load manifest" });
      }
    }

    if (method === "PUT") {
      try {
        const body = parseBody(event);
        const updates = EDITABLE_MANIFEST_FIELDS.filter((field) =>
          Object.prototype.hasOwnProperty.call(body, field),
        );
        if (updates.length === 0) {
          return jsonResponse(400, {
            error: `Provide at least one of: ${EDITABLE_MANIFEST_FIELDS.join(", ")}`,
          });
        }
        for (const field of updates) {
          const problem = validateManifestField(field, body[field]);
          if (problem) {
            return jsonResponse(400, { error: problem });
          }
        }

        const manifest = await readManifest(identifier);
        for (const field of updates) {
          if (body[field] === null) {
            delete manifest[field];
          } else {
            manifest[field] = body[field];
          }
        }
        await writeManifest(identifier, manifest);
        return jsonResponse(200, { manifest: manifestDetail(identifier, manifest) });
      } catch (error) {
        if (error.message === "Invalid JSON payload") {
          return jsonResponse(400, { error: error.message });
        }
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") {
          return jsonResponse(404, { error: "Manifest not found" });
        }
        console.error("Update manifest failed", error);
        return jsonResponse(500, { error: "Unable to update manifest" });
      }
    }

    if (method === "DELETE") {
      try {
        const manifest = await readManifest(identifier);
        await deleteManifestAssets(identifier, manifest);
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: manifestObjectKey(identifier) }));
        await s3
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: `${MANIFEST_PREFIX}/${identifier}/import-status.json` }))
          .catch(() => {});
        return jsonResponse(200, { deleted: true });
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") {
          return jsonResponse(404, { error: "Manifest not found" });
        }
        console.error("Delete manifest failed", error);
        return jsonResponse(500, { error: "Unable to delete manifest" });
      }
    }

    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (segments.length === 3 && segments[2] === "items") {
    if (method === "PUT") {
      try {
        const body = parseBody(event);
        if (!Array.isArray(body.items)) {
          return jsonResponse(400, { error: "items must be an array" });
        }
        const manifest = await readManifest(identifier);
        manifest.items = body.items;
        await writeManifest(identifier, manifest);
        return jsonResponse(200, { manifest: manifestDetail(identifier, manifest) });
      } catch (error) {
        if (error.message === "Invalid JSON payload") {
          return jsonResponse(400, { error: error.message });
        }
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") {
          return jsonResponse(404, { error: "Manifest not found" });
        }
        console.error("Update manifest items failed", error);
        return jsonResponse(500, { error: "Unable to update manifest" });
      }
    }

    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (segments.length === 3 && segments[2] === "import-status") {
    if (method === "GET") {
      try {
        const status = await readImportStatus(identifier);
        return jsonResponse(200, status);
      } catch (error) {
        console.error("Read import status failed", error);
        return jsonResponse(500, { error: "Unable to load import status" });
      }
    }

    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (segments.length === 3 && segments[2] === "import-resume") {
    if (method === "POST") {
      try {
        const status = await resumeAssetImport({ identifier });
        return jsonResponse(200, status);
      } catch (error) {
        console.error("Resume import failed", error);
        return jsonResponse(500, { error: "Unable to resume import" });
      }
    }

    return jsonResponse(405, { error: "Method not allowed" });
  }

  return jsonResponse(404, { error: "Unknown endpoint" });
};
