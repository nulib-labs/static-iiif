// Copying one canvas's image from a source IIIF Image API into our own.
//
// Moved here verbatim from app/aws/lambdas/manifest/importAssets.js so the
// per-work import walk and the collection import state machine share ONE
// implementation. This is the subtlest code in the repo — Image API v2/v3
// detection, URL rewriting that preserves region/size/rotation, and polling for
// a pyramid TIFF another Lambda is producing — and the repo already has a
// pointed lesson about private copies of shared machinery drifting.
//
// Loads the SDK, so it is NOT unit-testable from the repo root. See the table in
// AGENTS.md under Testing Guidelines.
const {Readable} = require("node:stream");
const {S3Client, HeadObjectCommand} = require("@aws-sdk/client-s3");
const {Upload} = require("@aws-sdk/lib-storage");
// SDK-free and unit-tested, so it lives with the rest of the source-document
// reshaping rather than here.
const {paintingBody} = require("./sourceFetch");

const s3 = new S3Client({});
const iiifBucket = process.env.IIIF_BUCKET;
const sourceBucket = process.env.SOURCE_BUCKET;
const imageApiBase = (process.env.IMAGE_API_BASE_URL || "").replace(/\/$/, "");

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 280000;

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

async function copyCanvasAsset({identifier, canvasIndex, canvas, onPhase}) {
  // The caller owns the status object: with a chunk of canvases in flight at
  // once, each writing its own progress would make them trample each other.
  const reportPhase = async (phase) => {
    if (onPhase) await onPhase(phase);
  };

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

module.exports = {
  copyCanvasAsset,
  paintingBody,
  repointManifestThumbnail,
  detectImageApiVersion,
  largestImageUrl,
  fetchJson,
  localService,
  localImageUrl,
  repointImageResources,
  repointCanvasDerivatives,
};
