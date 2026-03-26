const {S3Client, GetObjectCommand, PutObjectCommand} = require("@aws-sdk/client-s3");
const sharp = require("sharp");

const s3 = new S3Client({});
const IIIF_BUCKET = process.env.IIIF_BUCKET;
const SUPPORTED_EXTENSIONS = new Set([".jpg", ".jpeg", ".tif", ".tiff", ".png", ".webp"]);

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

exports.handler = async (event) => {
  for (const record of event.Records) {
    const sourceBucket = record.s3.bucket.name;
    const sourceKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    console.log(`Processing s3://${sourceBucket}/${sourceKey}`);

    const ext = sourceKey.slice(sourceKey.lastIndexOf(".")).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      console.log(`Skipping ${sourceKey} (unsupported type)`);
      continue;
    }

    const parts = sourceKey.split("/");
    const filename = parts.pop();
    const identifier = filename.replace(/\.[^.]+$/, "");
    const outputKey = [...parts, `${identifier}.tif`].join("/");

    const {Body} = await s3.send(new GetObjectCommand({Bucket: sourceBucket, Key: sourceKey}));
    const sourceBuffer = await streamToBuffer(Body);

    const pyramidBuffer = await sharp(sourceBuffer)
      .tiff({
        tile: true,
        tileWidth: 256,
        tileHeight: 256,
        pyramid: true,
        compression: "lzw",
      })
      .toBuffer();

    await s3.send(new PutObjectCommand({
      Bucket: IIIF_BUCKET,
      Key: outputKey,
      Body: pyramidBuffer,
      ContentType: "image/tiff",
    }));

    console.log(`Done: s3://${IIIF_BUCKET}/${outputKey}`);
  }
};
