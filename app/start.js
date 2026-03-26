const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const {processImage} = require("./local/image");

const projectRoot = path.resolve(__dirname, "..");
const sourceRoot = path.join(projectRoot, "source");
const outputRoot = path.join(projectRoot, "output");
const baseUrl = process.env.IIIF_BASE_URL;
const supportedExtensions = new Set([
  ".tif",
  ".tiff",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
]);
const inFlight = new Map();
const watcherMap = new Map();

function isSupportedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return supportedExtensions.has(ext);
}

async function handleImage(filePath) {
  if (inFlight.has(filePath)) return;
  inFlight.set(filePath, true);
  const relativePath = path.relative(sourceRoot, filePath);
  try {
    console.log(`[watch] processing ${relativePath}`);
    const result = await processImage({
      sourcePath: filePath,
      sourceRoot,
      outputRoot,
      baseUrl,
    });
    console.log(`[watch] finished ${relativePath} -> ${result.outputLocation}`);
  } catch (error) {
    console.error(`[watch] failed ${relativePath}:`, error.message);
  } finally {
    inFlight.delete(filePath);
  }
}

async function watchDirectory(directory) {
  if (watcherMap.has(directory)) {
    return;
  }

  const watcher = fs.watch(directory, async (eventType, filename) => {
    if (!filename) return;
    const targetPath = path.join(directory, filename.toString());
    try {
      const stats = await fsp.stat(targetPath);
      if (stats.isDirectory()) {
        await watchDirectory(targetPath);
      } else if (
        stats.isFile() &&
        isSupportedFile(targetPath) &&
        eventType !== "change"
      ) {
        await handleImage(targetPath);
      }
    } catch (error) {
      // File may have been deleted; ignore.
    }
  });

  watcherMap.set(directory, watcher);

  const entries = await fsp.readdir(directory, {withFileTypes: true});
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await watchDirectory(entryPath);
    } else if (entry.isFile() && isSupportedFile(entryPath)) {
      await handleImage(entryPath);
    }
  }
}

async function startWatcher() {
  await fsp.mkdir(sourceRoot, {recursive: true});
  console.log(`Watching ${sourceRoot} for new images...`);
  await watchDirectory(sourceRoot);
}

if (require.main === module) {
  startWatcher().catch((error) => {
    console.error("Watcher failed to start:", error.message);
    process.exit(1);
  });
}

module.exports = {startWatcher};
