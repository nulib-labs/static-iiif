const {Readable} = require("node:stream");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const {LambdaClient, InvokeCommand} = require("@aws-sdk/client-lambda");
const {Upload} = require("@aws-sdk/lib-storage");
const {
  MANIFEST_PREFIX,
  manifestObjectKey,
  readManifest: readManifestShared,
} = require("../../../shared/manifest");

const s3 = new S3Client({});
const lambdaClient = new LambdaClient({});
const iiifBucket = process.env.IIIF_BUCKET;
const sourceBucket = process.env.SOURCE_BUCKET;
const imageApiBase = (process.env.IMAGE_API_BASE_URL || "").replace(/\/$/, "");

const MAX_CANVAS_INDEX = 1000; // sanity valve against a runaway self-invoke chain
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 280000;

function importStatusKey(identifier) {
  return `${MANIFEST_PREFIX}/${identifier}/import-status.json`;
}

async function readManifest(identifier) {
  return readManifestShared({s3, bucket: iiifBucket, identifier});
}

async function writeManifest(identifier, manifest) {
  await s3.send(
    new PutObjectCommand({
      Bucket: iiifBucket,
      Key: manifestObjectKey(identifier),
      Body: JSON.stringify(manifest, null, 2),
      ContentType: "application/json",
    }),
  );
}

async function writeImportStatus(identifier, status) {
  await s3.send(
    new PutObjectCommand({
      Bucket: iiifBucket,
      Key: importStatusKey(identifier),
      Body: JSON.stringify({...status, updatedAt: new Date().toISOString()}, null, 2),
      ContentType: "application/json",
    }),
  );
}

async function readImportStatus(identifier) {
  try {
    const response = await s3.send(
      new GetObjectCommand({Bucket: iiifBucket, Key: importStatusKey(identifier)}),
    );
    const text = await response.Body.transformToString();
    return JSON.parse(text);
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") {
      return {status: "none", total: 0, completed: 0};
    }
    throw error;
  }
}

async function invokeSelf(payload) {
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

async function triggerAssetImport({identifier, total}) {
  if (!total) {
    return;
  }
  await writeImportStatus(identifier, {status: "in-progress", total, completed: 0});
  await invokeSelf({action: "importAssets", identifier, canvasIndex: 0});
}

async function resumeAssetImport({identifier}) {
  const status = await readImportStatus(identifier);
  if (status.status !== "in-progress" && status.status !== "failed") {
    return status; // nothing to resume
  }
  const canvasIndex = typeof status.currentIndex === "number" ? status.currentIndex : status.completed || 0;
  await writeImportStatus(identifier, {
    ...status,
    status: "in-progress",
    error: undefined,
  });
  await invokeSelf({action: "importAssets", identifier, canvasIndex});
  return readImportStatus(identifier);
}

async function handleImportFailure(event) {
  const identifier = event?.requestPayload?.identifier;
  const canvasIndex = event?.requestPayload?.canvasIndex;
  if (!identifier) {
    console.error("Import-assets: failure record missing identifier", event);
    return;
  }

  const condition = event?.requestContext?.condition || "Unknown";
  const responseError = event?.responsePayload?.errorMessage;
  const error = responseError ? `${condition}: ${responseError}` : condition;

  console.error(`Import-assets: canvas ${canvasIndex} of ${identifier} failed permanently (${error})`);

  const previous = await readImportStatus(identifier);
  await writeImportStatus(identifier, {
    ...previous,
    status: "failed",
    currentIndex: typeof canvasIndex === "number" ? canvasIndex : previous.currentIndex,
    error,
  });
}

function detectImageApiVersion(info) {
  if (info?.type === "ImageService3") {
    return 3;
  }
  if (info?.["@id"] && !info?.id) {
    return 2;
  }
  const context = info?.["@context"];
  const contextStr = Array.isArray(context) ? context.join(" ") : context || "";
  if (contextStr.includes("/image/2/")) {
    return 2;
  }
  return 3;
}

function largestImageUrl(info) {
  const serviceId = (info?.id || info?.["@id"] || "").replace(/\/$/, "");
  const sizeKeyword = detectImageApiVersion(info) === 3 ? "max" : "full";
  return `${serviceId}/full/${sizeKeyword}/0/default.jpg`;
}

async function fetchJson(url, timeoutMs = 15000) {
  const response = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with status ${response.status}`);
  }
  return response.json();
}

function paintingBody(canvas) {
  return canvas?.items?.[0]?.items?.[0]?.body || null;
}

async function copyCanvasAsset({identifier, canvasIndex, total, canvas}) {
  const reportPhase = (phase) =>
    writeImportStatus(identifier, {
      status: "in-progress",
      total,
      completed: canvasIndex,
      currentIndex: canvasIndex,
      phase,
    });

  const body = paintingBody(canvas);
  const serviceId = body?.service?.[0]?.id;
  if (!body || !serviceId) {
    console.warn(`Import-assets: canvas ${canvasIndex} of ${identifier} has no image service, skipping`);
    return;
  }
  if (imageApiBase && serviceId.startsWith(imageApiBase)) {
    return; // already pointing at our own Image API
  }

  await reportPhase("Fetching image info…");
  const sourceInfo = await fetchJson(`${serviceId.replace(/\/$/, "")}/info.json`);
  const imageUrl = largestImageUrl(sourceInfo);

  await reportPhase("Downloading image…");
  const imageResponse = await fetch(imageUrl, {signal: AbortSignal.timeout(120000)});
  if (!imageResponse.ok || !imageResponse.body) {
    throw new Error(`Unable to download image from ${imageUrl} (status ${imageResponse.status})`);
  }

  const baseKey = `image/imports/${identifier}/${canvasIndex}`;
  await reportPhase("Uploading to your library…");
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: sourceBucket,
      Key: `${baseKey}.jpg`,
      Body: Readable.fromWeb(imageResponse.body),
      ContentType: "image/jpeg",
    },
  });
  await upload.done();

  const tiffKey = `${baseKey}.tif`;
  await reportPhase("Converting image…");
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let converted = false;
  while (Date.now() < deadline) {
    try {
      await s3.send(new HeadObjectCommand({Bucket: iiifBucket, Key: tiffKey}));
      converted = true;
      break;
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== "NotFound") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
  if (!converted) {
    throw new Error(`Timed out waiting for pyramid conversion of ${tiffKey}`);
  }

  await reportPhase("Updating manifest…");
  const localInfo = await fetchJson(`${imageApiBase}/${encodeURIComponent(baseKey)}/info.json`);
  const localIsV3 = detectImageApiVersion(localInfo) === 3;
  const localServiceId = (localInfo?.id || localInfo?.["@id"] || "").replace(/\/$/, "");

  canvas.items[0].items[0].body = {
    id: `${localServiceId}/full/${localIsV3 ? "max" : "full"}/0/default.jpg`,
    type: "Image",
    format: "image/jpeg",
    width: localInfo.width,
    height: localInfo.height,
    service: [
      {
        id: localServiceId,
        type: localIsV3 ? "ImageService3" : "ImageService2",
        profile: localIsV3 ? "level2" : "http://iiif.io/api/image/2/level2.json",
      },
    ],
  };
}

async function handleImportAssets({identifier, canvasIndex}) {
  if (!identifier || typeof canvasIndex !== "number" || canvasIndex > MAX_CANVAS_INDEX) {
    console.error("Import-assets: invalid or runaway payload", {identifier, canvasIndex});
    return;
  }

  let manifest;
  try {
    manifest = await readManifest(identifier);
  } catch (error) {
    console.error(`Import-assets: manifest ${identifier} not found`, error);
    return;
  }

  const items = Array.isArray(manifest.items) ? manifest.items : [];
  if (canvasIndex >= items.length) {
    await writeImportStatus(identifier, {status: "complete", total: items.length, completed: items.length});
    console.log(`Import-assets: finished copying assets for ${identifier}`);
    return;
  }

  try {
    await copyCanvasAsset({identifier, canvasIndex, total: items.length, canvas: items[canvasIndex]});
    await writeManifest(identifier, manifest);
  } catch (error) {
    console.error(`Import-assets: canvas ${canvasIndex} of ${identifier} failed`, error);
  }

  await writeImportStatus(identifier, {
    status: "in-progress",
    total: items.length,
    completed: canvasIndex + 1,
    currentIndex: canvasIndex + 1,
    phase: null,
  });

  await invokeSelf({action: "importAssets", identifier, canvasIndex: canvasIndex + 1});
}

module.exports = {
  triggerAssetImport,
  handleImportAssets,
  readImportStatus,
  resumeAssetImport,
  handleImportFailure,
};
