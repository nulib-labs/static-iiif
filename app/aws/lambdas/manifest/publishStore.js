// S3 helpers for the publish routes. Separate from store.js, which is about
// manifests, and from the publish Lambda's own copy, which runs in a different
// function.
const {S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command} = require("@aws-sdk/client-s3");

const s3 = new S3Client({});
const bucket = process.env.IIIF_BUCKET;

async function readJson(key) {
  try {
    const response = await s3.send(new GetObjectCommand({Bucket: bucket, Key: key}));
    const bytes = await response.Body.transformToString();
    // The ETag rides along: it is what the conditional write uses as a mutex.
    return {document: {...JSON.parse(bytes), etag: response.ETag}, bytes, etag: response.ETag};
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") return null;
    throw error;
  }
}

async function putJson(key, document, options = {}) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(document, null, 2),
      ContentType: "application/json",
      ...options,
    }),
  );
}

async function listKeys(prefix) {
  const keys = [];
  let token;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({Bucket: bucket, Prefix: prefix, ContinuationToken: token}),
    );
    for (const item of response.Contents || []) keys.push(item.Key);
    token = response.NextContinuationToken;
  } while (token);
  return keys;
}

module.exports = {readJson, putJson, listKeys};
