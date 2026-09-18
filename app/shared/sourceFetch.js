// A IIIF document from somebody else's server: fetching it, and reducing it to
// what we are willing to store.
//
// Extracted from app/aws/lambdas/manifest/index.js so the collection import
// state machine fetches sources under exactly the same rules the work import
// already enforces — redirects refused, size capped, type checked. SDK-free and
// unit-tested; see the table in AGENTS.md under Testing Guidelines.

class ImportError extends Error {
  // `retryable` marks the failures that are about the source being momentarily
  // unable rather than about what the curator pasted — throttling, a gateway
  // hiccup, an unreachable host. A collection import lets those bubble out of
  // the batch so the state machine's Retry backs off, instead of recording a few
  // hundred works as permanently failed because the source asked us to slow
  // down. A 400 never gets a second attempt: the answer would be the same.
  constructor(status, message, {retryable = false} = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

// 429 is the explicit ask. 5xx is the source failing on its own account, which a
// retry can legitimately clear.
function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

// Stay comfortably under the 6MB Lambda payload cap: a manifest is echoed back
// to the browser by the preview route and sent up again on import.
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

// A Collection is a list of references — roughly 600 bytes a member against a
// manifest's several KB a canvas — but tens of thousands of members still adds
// up. The higher cap is safe because a Collection is NEVER echoed to the
// browser: preview returns a summary and Plan re-fetches server-side, so this
// document only ever has to fit in Lambda memory.
const MAX_COLLECTION_BYTES = 20 * 1024 * 1024;

function validateSourceUrl(raw, {noun = "manifest"} = {}) {
  const value = (raw || "").trim();
  if (!value) {
    throw new ImportError(400, `A ${noun} URL is required`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ImportError(400, "That doesn't look like a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ImportError(400, "Only http(s) URLs are supported");
  }
  return parsed.toString();
}

// `expect` is "Manifest" or "Collection". Getting the other one is the single
// most likely mistake at this field, so each says so by name rather than
// reporting a generic type error.
function checkType(document, expect) {
  const type = document?.type || document?.["@type"];
  const normalized = typeof type === "string" ? type.toLowerCase() : "";

  if (expect === "Manifest") {
    if (normalized.includes("collection")) {
      throw new ImportError(
        400,
        "That's a Collection. Use Import Collection on the Collections screen, or paste a single Manifest URL.",
      );
    }
    if (type !== "Manifest") {
      throw new ImportError(400, "Only IIIF Presentation 3.0 Manifests are supported right now.");
    }
    return document;
  }

  if (expect === "Collection") {
    if (type === "Manifest") {
      throw new ImportError(
        400,
        "That's a single Manifest. Use Import Works inside a collection, or paste a Collection URL.",
      );
    }
    if (type !== "Collection") {
      throw new ImportError(400, "Only IIIF Presentation 3.0 Collections are supported right now.");
    }
    return document;
  }

  throw new Error(`Unknown expected type: ${expect}`);
}

async function fetchSourceDocument(sourceUrl, {expect, maxBytes, fetchImpl = fetch} = {}) {
  const cap = maxBytes || (expect === "Collection" ? MAX_COLLECTION_BYTES : MAX_MANIFEST_BYTES);
  const tooBig = `That ${expect.toLowerCase()} is too large to import (max ${Math.round(cap / 1024 / 1024)}MB)`;

  let response;
  try {
    response = await fetchImpl(sourceUrl, {
      headers: {Accept: "application/json"},
      // Manual, so a redirect is reported rather than silently followed to
      // somewhere the curator did not paste.
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new ImportError(502, `Unable to reach that URL: ${error.message}`, {retryable: true});
  }

  if (response.status >= 300 && response.status < 400) {
    throw new ImportError(
      400,
      "The URL returned a redirect — please paste the final URL directly.",
    );
  }
  if (!response.ok) {
    throw new ImportError(400, `Source server returned ${response.status}`, {
      retryable: isRetryableStatus(response.status),
    });
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength && contentLength > cap) {
    throw new ImportError(400, tooBig);
  }

  const text = await response.text();
  if (text.length > cap) {
    throw new ImportError(400, tooBig);
  }

  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new ImportError(400, "URL did not return valid JSON");
  }

  return checkType(document, expect);
}

// The Manifest members of a Collection, in order.
//
// Nested sub-collections are SKIPPED rather than recursed into, and counted so
// the caller can say so. Recursion would make one paste an unbounded walk of
// somebody else's tree, and the collections this was built for do not nest.
function collectionMembers(collection) {
  const items = Array.isArray(collection?.items) ? collection.items : [];
  const manifests = [];
  let skippedCollections = 0;
  for (const item of items) {
    if (item?.type === "Manifest" && typeof item.id === "string") manifests.push(item);
    else if (item?.type === "Collection") skippedCollections += 1;
  }
  return {manifests, skippedCollections};
}

function paintingBody(canvas) {
  return canvas?.items?.[0]?.items?.[0]?.body || null;
}

// Audio and video are dropped, deliberately and for now. We cannot make a
// pyramid TIFF of a sound file, and passing the canvas through would leave a
// published manifest pointing at the source's streaming server — which is the
// one thing a published collection must not do. A/V support is coming; when it
// lands, these works are re-imported.
//
// A/V is per CANVAS, not per work: a source may hang supplemental images off an
// A/V work, so this keeps those and drops only what it cannot host. A work left
// with no canvases at all is allowed — triggerAssetImport no-ops on zero.
function imageCanvasesOnly(manifest) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  const kept = items.filter((canvas) => paintingBody(canvas)?.type === "Image");
  return {items: kept, dropped: items.length - kept.length};
}

module.exports = {
  ImportError,
  MAX_MANIFEST_BYTES,
  MAX_COLLECTION_BYTES,
  validateSourceUrl,
  fetchSourceDocument,
  collectionMembers,
  paintingBody,
  imageCanvasesOnly,
};
