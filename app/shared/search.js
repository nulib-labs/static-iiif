function encodeManifestId(manifestUrl) {
  return Buffer.from(manifestUrl, "utf8").toString("base64url");
}

function decodeManifestId(encoded) {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

function buildSearchDocument({label, manifestUrl}) {
  return {
    id: encodeManifestId(manifestUrl),
    manifestId: manifestUrl,
    title: label,
  };
}

module.exports = {
  encodeManifestId,
  decodeManifestId,
  buildSearchDocument,
};
