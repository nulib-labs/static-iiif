// IIIF language maps are {"none": ["a", "b"]}. Imported manifests routinely lack
// `summary` and `behavior` entirely, so every read here tolerates undefined.
//
// A lib module rather than a co-export from a component file: the Vite react-refresh
// rule (ui/eslint.config.js:13) warns on exported functions alongside components.
export function readLanguageMap(map) {
  const values = map && typeof map === "object" ? Object.values(map)[0] : null;
  return Array.isArray(values) ? values : [];
}

export function toLanguageMap(values) {
  return {none: values};
}
