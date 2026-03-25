const fs = require("fs/promises");
const path = require("path");
const pathPosix = path.posix;
const sharp = require("sharp");
const {createStorage} = require("../storage");

function normalizeFormat(format) {
  const normalized = (format || "jpg").toLowerCase();
  if (normalized === "jpg") return "jpeg";
  return normalized;
}

async function getImageSize(sourceBuffer) {
  const metadata = await sharp(sourceBuffer).metadata();
  const {width, height} = metadata;
  if (!width || !height) {
    throw new Error("Unable to determine source dimensions");
  }
  return {width, height};
}

function ensurePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, received ${value}`);
  }
  return parsed;
}

const formatContentTypes = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  tiff: "image/tiff",
};

async function createIiifTiles({
  sourceBuffer,
  storage,
  outputPrefix,
  tileWidth = 512,
  tileHeight = 512,
  scaleFactors = [1],
  format = "jpg",
}) {
  const normalizedFormat = normalizeFormat(format);
  const contentType =
    formatContentTypes[normalizedFormat] || "application/octet-stream";
  const {width, height} = await getImageSize(sourceBuffer);
  const summary = [];

  for (const factor of scaleFactors) {
    const scaleFactor = ensurePositiveInt(factor);
    const scaledWidth = Math.ceil(width / scaleFactor);
    const scaledHeight = Math.ceil(height / scaleFactor);
    const columns = Math.ceil(scaledWidth / tileWidth);
    const rows = Math.ceil(scaledHeight / tileHeight);

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const scaledX = col * tileWidth;
        const scaledY = row * tileHeight;
        const scaledTileWidth = Math.min(tileWidth, scaledWidth - scaledX);
        const scaledTileHeight = Math.min(tileHeight, scaledHeight - scaledY);
        const regionX = Math.min(width - 1, Math.floor(scaledX * scaleFactor));
        const regionY = Math.min(height - 1, Math.floor(scaledY * scaleFactor));
        const regionWidth = Math.max(
          1,
          Math.min(width - regionX, Math.ceil(scaledTileWidth * scaleFactor)),
        );
        const regionHeight = Math.max(
          1,
          Math.min(height - regionY, Math.ceil(scaledTileHeight * scaleFactor)),
        );
        const regionSegment = `${regionX},${regionY},${regionWidth},${regionHeight}`;
        const sizeSegment = `${scaledTileWidth},${scaledTileHeight}`;
        const tileKey = pathPosix.join(
          outputPrefix,
          regionSegment,
          sizeSegment,
          "0",
          `default.${format}`,
        );

        const tileBuffer = await sharp(sourceBuffer)
          .extract({
            left: regionX,
            top: regionY,
            width: regionWidth,
            height: regionHeight,
          })
          .resize(scaledTileWidth, scaledTileHeight, {fit: sharp.fit.fill})
          .toFormat(normalizedFormat)
          .toBuffer();

        await storage.writeBinary(tileKey, tileBuffer, contentType);
      }
    }

    summary.push({
      factor: scaleFactor,
      width: scaledWidth,
      height: scaledHeight,
      columns,
      rows,
    });
  }

  return {width, height, summary};
}

async function writeInfoJson({
  serviceId,
  width,
  height,
  storage,
  outputPrefix,
  tileWidth,
  tileHeight,
  scaleFactors,
  profile = "level0",
}) {
  const sizes = Array.from(
    new Map(
      scaleFactors.map((factor) => {
        const scaledWidth = Math.ceil(width / factor);
        const scaledHeight = Math.ceil(height / factor);
        return [
          `${scaledWidth}x${scaledHeight}`,
          {width: scaledWidth, height: scaledHeight},
        ];
      }),
    ).values(),
  );

  const payload = {
    "@context": "http://iiif.io/api/image/3/context.json",
    id: serviceId,
    type: "ImageService3",
    protocol: "http://iiif.io/api/image",
    profile,
    width,
    height,
    tiles: [
      {
        width: tileWidth,
        height: tileHeight,
        scaleFactors,
      },
    ],
    sizes,
  };

  const infoKey = pathPosix.join(outputPrefix, "info.json");
  await storage.writeJson(infoKey, payload);
  return infoKey;
}

function buildServiceId(baseUrl, relativeSegments) {
  const base = (baseUrl || "").replace(/\/$/, "");
  const suffix = relativeSegments.filter(Boolean).join("/");
  return base ? `${base}/${suffix}` : suffix;
}

async function processImage({
  sourcePath,
  sourceRoot,
  outputRoot,
  baseUrl,
  tileWidth = 512,
  tileHeight = 512,
  scaleFactors = [1, 2, 4],
  format = "jpg",
  storage,
  storageOptions = {},
}) {
  const normalizedSourceRoot = sourceRoot || path.dirname(sourcePath);
  const relativePath = path.relative(normalizedSourceRoot, sourcePath);
  if (relativePath.startsWith("..")) {
    throw new Error(
      `Source path ${sourcePath} is not inside ${normalizedSourceRoot}`,
    );
  }

  const relativeDir =
    path.dirname(relativePath) === "." ? "" : path.dirname(relativePath);
  const identifier = path.basename(relativePath, path.extname(relativePath));
  const relativeDirPosix = relativeDir
    ? relativeDir.split(path.sep).join("/")
    : "";
  const outputPrefix = relativeDirPosix
    ? `${relativeDirPosix}/${identifier}`
    : identifier;

  const activeStorage =
    storage ||
    createStorage({
      outputRoot,
      localRoot: outputRoot,
      ...storageOptions,
    });

  const sourceBuffer = await fs.readFile(sourcePath);
  const tileResult = await createIiifTiles({
    sourceBuffer,
    storage: activeStorage,
    outputPrefix,
    tileWidth,
    tileHeight,
    scaleFactors,
    format,
  });

  const serviceSegments = [];
  if (relativeDir) {
    serviceSegments.push(...relativeDir.split(path.sep));
  }
  serviceSegments.push(identifier);
  const serviceId = buildServiceId(baseUrl, serviceSegments);

  await writeInfoJson({
    serviceId,
    width: tileResult.width,
    height: tileResult.height,
    storage: activeStorage,
    outputPrefix,
    tileWidth,
    tileHeight,
    scaleFactors,
  });

  const outputLocation =
    activeStorage.kind === "local"
      ? path.join(activeStorage.root, ...outputPrefix.split("/"))
      : outputPrefix;

  return {
    identifier,
    relativeDir,
    outputPrefix,
    outputLocation,
    serviceId,
    width: tileResult.width,
    height: tileResult.height,
  };
}

async function main() {
  const projectRoot = path.resolve(__dirname, "../..");
  const sourceRoot = path.join(projectRoot, "source");
  const outputRoot = path.join(projectRoot, "output");
  const sourcePath = path.join(sourceRoot, "image/debois.tif");
  const baseUrl = process.env.IIIF_BASE_URL;

  const result = await processImage({
    sourcePath,
    sourceRoot,
    outputRoot,
    baseUrl,
  });

  console.log(
    `Generated IIIF output for ${path.relative(sourceRoot, sourcePath)} (${result.width}x${result.height}) at ${result.outputLocation}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  createIiifTiles,
  writeInfoJson,
  processImage,
  main,
};
