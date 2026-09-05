// IIIF language maps — {"none": ["value", ...]} — and reading a single display
// string back out of one.
//
// Split out of manifest.js so modules that only need the value shapes don't have
// to load the AWS SDK along with them. Keep this file dependency-free.

function languageMap(value) {
  return {none: [String(value ?? "")]};
}

function extractLabel(labelValue) {
  if (typeof labelValue === "string") {
    return labelValue;
  }
  if (Array.isArray(labelValue)) {
    return labelValue.find((entry) => typeof entry === "string") || "";
  }
  if (labelValue && typeof labelValue === "object") {
    const candidates = labelValue.none || Object.values(labelValue)[0];
    if (Array.isArray(candidates)) {
      return candidates.find((entry) => typeof entry === "string") || "";
    }
  }
  return "";
}

module.exports = {
  languageMap,
  extractLabel,
};
