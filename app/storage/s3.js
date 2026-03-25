const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

function ensureValue(value, message) {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

class S3Storage {
  constructor({ bucket, prefix = "", region, client }) {
    this.bucket = ensureValue(bucket, "S3 bucket is required");
    this.prefix = prefix.replace(/\/$/, "");
    this.client = client || new S3Client({ region });
    this.kind = "s3";
  }

  buildKey(key) {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async writeBinary(key, buffer, contentType) {
    const Key = this.buildKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    return Key;
  }

  async writeJson(key, payload) {
    const json = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    return this.writeBinary(key, Buffer.from(json), "application/json");
  }
}

module.exports = { S3Storage };
