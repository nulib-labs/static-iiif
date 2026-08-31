// Shared by App.jsx (reorder/remove, manifest fetch/save) and AssetDropzone.jsx
// (upload + attach) — anything that builds or resolves a canvas from an S3 asset key.

const IIIF_BASE_URL = (import.meta.env.VITE_IIIF_BASE_URL || "").replace(/\/$/, "");

export function slugifyManifestId(value) {
  return (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildInfoUrlFromKey(key) {
  if (!IIIF_BASE_URL || !key) return "";
  const identifier = key.replace(/\.[^./]+$/, "");
  return `${IIIF_BASE_URL}/${encodeURIComponent(identifier)}/info.json`;
}

export function assetLabelFromKey(key) {
  const basename = (key || "").split("/").filter(Boolean).pop() || "";
  return basename.replace(/\.[^./]+$/, "");
}

// A resolved IIIF image info response is always servable as a thumbnail JPEG,
// unlike the original upload (which may be a browser-unrenderable format like TIFF).
export function buildThumbnailUrlFromInfo(imageInfo, size = 64) {
  const serviceId = imageInfo?.id || imageInfo?.["@id"];
  if (!serviceId) return null;
  return `${serviceId.replace(/\/$/, "")}/full/,${size}/0/default.jpg`;
}

export function buildCanvasResource(manifest, imageInfo, label) {
  if (!manifest?.id) {
    throw new Error("Work is missing an id");
  }
  // serverless-iiif currently serves IIIF Image API 2.1 (`@context`/`@id`), not 3.x (`id`) — support both.
  const imageId = imageInfo?.id || imageInfo?.["@id"];
  if (!imageId) {
    throw new Error("Image info is missing an id");
  }
  const isImageApi2 =
    /\/image\/2\//.test(imageInfo?.["@context"] || "") || (!imageInfo?.id && Boolean(imageInfo?.["@id"]));
  const manifestBase = manifest.id.replace(/\/manifest\.json$/i, "");
  const normalizedLabel = label?.trim() || "Asset";
  const slugBase = slugifyManifestId(normalizedLabel) || slugifyManifestId(imageId.split("/").pop() || "");
  const uniqueSlug = slugBase ? `${slugBase}-${Date.now().toString(36)}` : Date.now().toString(36);
  const canvasId = `${manifestBase}/canvas/${uniqueSlug}`;
  const pageId = `${canvasId}/page/1`;
  const annotationId = `${canvasId}/annotation/1`;
  const serviceId = imageId.replace(/\/$/, "");
  const imageService = {
    id: serviceId,
    type: imageInfo.type || (isImageApi2 ? "ImageService2" : "ImageService3"),
    profile: Array.isArray(imageInfo.profile)
      ? imageInfo.profile[0]
      : imageInfo.profile || "level0",
    width: imageInfo.width,
    height: imageInfo.height,
  };
  const canvas = {
    id: canvasId,
    type: "Canvas",
    width: imageInfo.width,
    height: imageInfo.height,
    items: [
      {
        id: pageId,
        type: "AnnotationPage",
        items: [
          {
            id: annotationId,
            type: "Annotation",
            motivation: "painting",
            target: canvasId,
            body: {
              id: `${serviceId}/full/${isImageApi2 ? "full" : "max"}/0/default.jpg`,
              type: "Image",
              format: "image/jpeg",
              width: imageInfo.width,
              height: imageInfo.height,
              service: [imageService],
            },
          },
        ],
      },
    ],
  };
  if (normalizedLabel) {
    canvas.label = {none: [normalizedLabel]};
  }
  return canvas;
}
