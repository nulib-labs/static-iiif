const {S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command} = require("@aws-sdk/client-s3");

const s3 = new S3Client({});
const bucket = process.env.IIIF_BUCKET;

async function streamToString(body) {
  if (typeof body === "string") return body;
  if (body && typeof body.transformToString === "function") return body.transformToString();
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function isNotFound(error) {
  return error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey";
}

// Returns the raw bytes alongside the parsed document: the content hash must
// be of what is actually stored, never of a re-serialization.
async function readJson(key) {
  try {
    const response = await s3.send(new GetObjectCommand({Bucket: bucket, Key: key}));
    const bytes = await streamToString(response.Body);
    return {document: JSON.parse(bytes), bytes, etag: response.ETag};
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function putJson(key, document, options = {}) {
  const body = JSON.stringify(document, null, 2);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
      ...options,
    }),
  );
  return body;
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

module.exports = {s3, bucket, readJson, putJson, listKeys, isNotFound};
