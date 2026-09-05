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

// This function holds a manifest in memory for minutes at a time — copyCanvasAsset
// polls up to POLL_TIMEOUT_MS per canvas waiting for the pyramid TIFF — and a
// blind write-back would silently revert anything a curator changed meanwhile
// (a title, a description, collection membership). Re-read immediately before
// writing and carry over only the fields this chain actually owns.
//
// Still not atomic, but the window shrinks from minutes to one S3 round-trip.
// The principled fix is a conditional write on the ETag, which belongs in its
// own change because it touches every writer.
async function writeManifestItems(identifier, manifest) {
  let current;
  try {
    current = await readManifest(identifier);
  } catch (error) {
    console.error(`Import-assets: could not re-read manifest ${identifier} before write`, error);
    current = manifest;
  }
  current.items = manifest.items;
  if (manifest.thumbnail) {
    current.thumbnail = manifest.thumbnail;
  }
  await writeManifest(identifier, current);
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
  const stoppedAt = typeof status.currentIndex === "number" ? status.currentIndex : status.completed || 0;
  // Rewind to the earliest canvas that failed so a retry actually re-attempts it.
  // Canvases already copied are skipped cheaply (copyCanvasAsset no-ops once a
  // canvas points at our own Image API), so re-walking from there costs little.
  const failures = Array.isArray(status.failures) ? status.failures : [];
  const earliestFailure = failures.reduce(
    (min, f) => (typeof f?.canvasIndex === "number" ? Math.min(min, f.canvasIndex) : min),
    Infinity,
  );
  const canvasIndex = Number.isFinite(earliestFailure) ? Math.min(earliestFailure, stoppedAt) : stoppedAt;

  await writeImportStatus(identifier, {
    ...status,
    status: "in-progress",
    currentIndex: canvasIndex,
    failures: [],
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

function localService(serviceId, isV3) {
  return {
    id: serviceId,
    type: isV3 ? "ImageService3" : "ImageService2",
    profile: isV3 ? "level2" : "http://iiif.io/api/image/2/level2.json",
  };
}

// A IIIF Image API request tail: {region}/{size}/{rotation}/{quality}.{format}.
// Matched strictly so a plain, non-IIIF image URL (some sources use one for
// their thumbnails) falls back rather than being mangled into a broken path.
const IMAGE_REQUEST_PATTERN =
  /\/(full|square|pct:[\d.,]+|\d+,\d+,\d+,\d+)\/(max|full|pct:[\d.]+|!?\d*,\d*)\/(!?[\d.]+)\/[^/]+$/;

// Rewrites a source Image API URL onto our own service, preserving the region,
// size and rotation the source asked for (e.g. a "!300,300" thumbnail stays a
// "!300,300" thumbnail) and translating the v2/v3 full-size keyword.
function localImageUrl(sourceUrl, serviceId, isV3) {
  const parts = IMAGE_REQUEST_PATTERN.exec(sourceUrl || "");
  if (!parts) {
    return `${serviceId}/full/${isV3 ? "max" : "full"}/0/default.jpg`;
  }
  const [, region, rawSize, rotation] = parts;
  let size = rawSize;
  if (size === "max" && !isV3) size = "full";
  if (size === "full" && isV3) size = "max";
  return `${serviceId}/${region}/${size}/${rotation}/default.jpg`;
}

// Repoints a IIIF list of Image resources (canvas.thumbnail, manifest.thumbnail…)
// at our own service.
function repointImageResources(resources, serviceId, isV3) {
  if (!Array.isArray(resources)) return;
  for (const resource of resources) {
    if (!resource?.id) continue;
    resource.id = localImageUrl(resource.id, serviceId, isV3);
    if (Array.isArray(resource.service)) {
      resource.service = [localService(serviceId, isV3)];
    }
  }
}

// A canvas's thumbnail and placeholderCanvas are derivatives of the same source
// image as its painting body, so they follow it to the service we just created.
function repointCanvasDerivatives(canvas, serviceId, isV3) {
  repointImageResources(canvas?.thumbnail, serviceId, isV3);
  for (const page of canvas?.placeholderCanvas?.items || []) {
    for (const annotation of page?.items || []) {
      if (annotation?.body) {
        repointImageResources([annotation.body], serviceId, isV3);
      }
    }
  }
}

// Many sources expose a manifest-level thumbnail as a plain URL on their own
// API with no image service behind it. Rather than copy a second, redundant
// derivative, point it at the first canvas's freshly migrated thumbnail.
function repointManifestThumbnail(manifest) {
  const firstThumbnail = manifest?.items?.[0]?.thumbnail?.[0];
  const serviceId = firstThumbnail?.service?.[0]?.id;
  if (!firstThumbnail?.id || !serviceId) return false;
  if (!imageApiBase || !serviceId.startsWith(imageApiBase)) return false;
  manifest.thumbnail = [structuredClone(firstThumbnail)];
  return true;
}

async function copyCanvasAsset({identifier, canvasIndex, total, canvas, failures = []}) {
  const reportPhase = (phase) =>
    writeImportStatus(identifier, {
      status: "in-progress",
      total,
      completed: canvasIndex,
      currentIndex: canvasIndex,
      failures,
      phase,
    });

  const body = paintingBody(canvas);
  const serviceId = body?.service?.[0]?.id;
  if (!body || !serviceId) {
    console.warn(`Import-assets: canvas ${canvasIndex} of ${identifier} has no image service, skipping`);
    return;
  }
  if (imageApiBase && serviceId.startsWith(imageApiBase)) {
    // Image is already ours. Its derivatives may not be: earlier imports
    // repointed the painting body only, so make them catch up.
    repointCanvasDerivatives(canvas, serviceId, body.service[0]?.type === "ImageService3");
    return;
  }

  await reportPhase("Fetching image info…");
  const sourceInfo = await fetchJson(`${serviceId.replace(/\/$/, "")}/info.json`);
  const imageUrl = largestImageUrl(sourceInfo);

  await reportPhase("Downloading image…");
  const imageResponse = await fetch(imageUrl, {signal: AbortSignal.timeout(120000)});
  if (!imageResponse.ok || !imageResponse.body) {
    throw new Error(`Unable to download image from ${imageUrl} (status ${imageResponse.status})`);
  }

  const baseKey = `image/${identifier}/${canvasIndex}`;
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

  await reportPhase("Repointing image and thumbnails…");
  const localInfo = await fetchJson(`${imageApiBase}/${encodeURIComponent(baseKey)}/info.json`);
  const localIsV3 = detectImageApiVersion(localInfo) === 3;
  const localServiceId = (localInfo?.id || localInfo?.["@id"] || "").replace(/\/$/, "");

  canvas.items[0].items[0].body = {
    id: `${localServiceId}/full/${localIsV3 ? "max" : "full"}/0/default.jpg`,
    type: "Image",
    format: "image/jpeg",
    width: localInfo.width,
    height: localInfo.height,
    service: [localService(localServiceId, localIsV3)],
  };

  repointCanvasDerivatives(canvas, localServiceId, localIsV3);
}

async function handleImportAssets({identifier, canvasIndex}) {
  if (!identifier || typeof canvasIndex !== "number" || canvasIndex > MAX_CANVAS_INDEX) {
    console.error("Import-assets: invalid or runaway payload", {identifier, canvasIndex});
    if (identifier) {
      // Leave a terminal record; otherwise the status object is stranded at
      // "in-progress" forever and the UI polls it indefinitely.
      const previous = await readImportStatus(identifier).catch(() => null);
      if (previous && previous.status === "in-progress") {
        await writeImportStatus(identifier, {...previous, status: "failed", error: "Import stopped: invalid state"});
      }
    }
    return;
  }

  let manifest;
  try {
    manifest = await readManifest(identifier);
  } catch (error) {
    console.error(`Import-assets: manifest ${identifier} not found`, error);
    const previous = await readImportStatus(identifier).catch(() => null);
    if (previous && previous.status === "in-progress") {
      await writeImportStatus(identifier, {...previous, status: "failed", error: "Manifest could not be read"});
    }
    return;
  }

  const previousStatus = await readImportStatus(identifier).catch(() => null);
  const failures = Array.isArray(previousStatus?.failures) ? previousStatus.failures : [];

  const items = Array.isArray(manifest.items) ? manifest.items : [];
  if (canvasIndex >= items.length) {
    await writeImportStatus(identifier, {
      status: "in-progress",
      total: items.length,
      completed: items.length,
      currentIndex: items.length,
      failures,
      phase: "Updating manifest thumbnail…",
    });
    if (repointManifestThumbnail(manifest)) {
      await writeManifestItems(identifier, manifest);
    }
    // A canvas that failed to copy still points at the source, so the import is
    // not "complete" just because the chain reached the end.
    await writeImportStatus(identifier, {
      status: failures.length ? "failed" : "complete",
      total: items.length,
      completed: items.length,
      failures,
      error: failures.length
        ? `${failures.length} of ${items.length} image${failures.length === 1 ? "" : "s"} could not be copied`
        : undefined,
    });
    console.log(
      `Import-assets: finished ${identifier} with ${failures.length} failure(s) of ${items.length}`,
    );
    return;
  }

  try {
    await copyCanvasAsset({
      identifier,
      canvasIndex,
      total: items.length,
      canvas: items[canvasIndex],
      failures,
    });
    await writeManifestItems(identifier, manifest);
  } catch (error) {
    console.error(`Import-assets: canvas ${canvasIndex} of ${identifier} failed`, error);
    failures.push({canvasIndex, error: error.message});
  }

  await writeImportStatus(identifier, {
    status: "in-progress",
    total: items.length,
    completed: canvasIndex + 1,
    currentIndex: canvasIndex + 1,
    failures,
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
