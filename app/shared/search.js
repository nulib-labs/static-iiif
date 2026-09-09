function encodeManifestId(manifestUrl) {
  return Buffer.from(manifestUrl, "utf8").toString("base64url");
}

function decodeManifestId(encoded) {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

// `collections` is what lets a search be scoped to the caller's grants without
// joining against the manifest corpus on every query. A document with an empty
// array is an uncollected work, which only an admin can see.
function buildSearchDocument({label, manifestUrl, collections = []}) {
  return {
    id: encodeManifestId(manifestUrl),
    manifestId: manifestUrl,
    title: label,
    collections,
  };
}

module.exports = {
  encodeManifestId,
  decodeManifestId,
  buildSearchDocument,
};
