const path = require("path");
const { LocalStorage } = require("./local");
let S3Storage;

function createStorage(options = {}) {
  const driver = options.driver || process.env.STORAGE_DRIVER || "local";
  if (driver === "s3") {
    S3Storage = S3Storage || require("./s3").S3Storage;
    const bucket = options.bucket || process.env.S3_BUCKET;
    const prefix = options.prefix || process.env.S3_PREFIX || "";
    const region = options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    return new S3Storage({ bucket, prefix, region });
  }

  const root = options.localRoot || options.outputRoot || process.env.OUTPUT_ROOT || path.resolve("output");
  return new LocalStorage({ root });
}

module.exports = { createStorage };
