const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const sharp = require("sharp");

const s3 = new S3Client({});
const IIIF_BUCKET = process.env.IIIF_BUCKET;

exports.handler = async (event) => {
  for (const record of event.Records) {
    const sourceBucket = record.s3.bucket.name;
    const sourceKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    console.log(`Processing s3://${sourceBucket}/${sourceKey}`);

    const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".tif", ".tiff"];
    const ext = sourceKey.slice(sourceKey.lastIndexOf(".")).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      console.log(`Skipping ${sourceKey} (unsupported type)`);
      continue;
    }

    const parts = sourceKey.split("/");
    const filename = parts.pop();
    const prefix = parts.join("/");
    const identifier = filename.replace(/\.[^.]+$/, "");

    
    await Promise.all(uploads);
    console.log(`Done: ${uploads.length} pyramid generated for "${identifier}"`);
  }
};
