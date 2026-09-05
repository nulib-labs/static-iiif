// Shared response shaping for the manifest API.
//
// Extracted from index.js so sibling handler modules can build responses without
// requiring index.js back — a cycle there bundles into partially-initialized
// exports.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
    body: JSON.stringify(payload),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON payload");
  }
}

function isNotFound(error) {
  return error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey" || error?.name === "NotFound";
}

module.exports = {
  corsHeaders,
  jsonResponse,
  parseBody,
  isNotFound,
};
