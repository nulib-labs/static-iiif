const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const {
  sanitizeManifestIdentifier,
  manifestObjectKey,
  createManifestTemplate,
} = require("../../../shared/manifest");

const s3 = new S3Client({});
const bucket = process.env.IIIF_BUCKET;
const manifestBaseUrl = (process.env.IIIF_BASE_URL || "").replace(/\/$/, "");
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
};

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

function manifestSummary(identifier, manifest) {
  const label = manifest?.label?.none?.[0] || "";
  return {
    identifier,
    label,
    manifestUrl: manifest?.id || "",
    relativePath: manifestObjectKey(identifier),
    itemCount: Array.isArray(manifest?.items) ? manifest.items.length : 0,
  };
}

function manifestDetail(identifier, manifest) {
  return {
    ...manifestSummary(identifier, manifest),
    manifest,
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

async function readManifest(identifier) {
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

async function manifestExists(identifier) {
  const key = manifestObjectKey(identifier);
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") {
      return false;
    }
    throw error;
  }
}

async function listManifestSummaries() {
  const manifests = [];
  let continuationToken;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "presentation/manifest/",
        ContinuationToken: continuationToken,
      }),
    );
    const manifestObjects = (response.Contents || []).filter((item) =>
      item.Key.endsWith("/manifest.json"),
    );
    await Promise.all(
      manifestObjects.map(async (object) => {
        const identifier = object.Key.split("/")[2];
        try {
          const manifest = await readManifest(identifier);
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
        const identifier = sanitizeManifestIdentifier(body.identifier || body.id);
        const label = (body.label || "").trim();
        if (!label) {
          return jsonResponse(400, { error: "Label is required" });
        }
        const exists = await manifestExists(identifier);
        if (exists) {
          return jsonResponse(409, { error: "A manifest with that id already exists" });
        }
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

  return jsonResponse(404, { error: "Unknown endpoint" });
};
