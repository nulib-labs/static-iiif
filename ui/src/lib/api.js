// The API layer every authenticated screen shares: Amplify configuration, the
// deployed endpoint bases, and one fetch wrapper that owns the error contract.
//
// This lives outside App.jsx so a route that is not the works screen (the
// collections and users sections) can call the API without importing the whole
// works UI along with it.
import {Amplify} from "aws-amplify";
import {fetchAuthSession} from "aws-amplify/auth";

export const MANIFEST_API_BASE = (import.meta.env.VITE_MANIFEST_API_URL || "").replace(/\/$/, "");
export const SEARCH_API_BASE = (import.meta.env.VITE_SEARCH_API_URL || "").replace(/\/$/, "");
// VITE_MANIFEST_API_URL already ends in /manifests, so the collections
// vocabulary is a sibling endpoint rather than a child of it. The fallback
// derives one so the feature still works against a stack deployed before the
// variable existed.
export const COLLECTION_API_BASE = (
  import.meta.env.VITE_COLLECTION_API_URL ||
  (/\/manifests$/.test(MANIFEST_API_BASE) ? MANIFEST_API_BASE.replace(/\/manifests$/, "/collections") : "")
).replace(/\/$/, "");
export const STORAGE_BUCKET = import.meta.env.VITE_STORAGE_BUCKET || "";
export const STORAGE_REGION =
  import.meta.env.VITE_STORAGE_REGION || import.meta.env.VITE_AWS_REGION || "";
export const STORAGE_IDENTITY_POOL_ID = import.meta.env.VITE_STORAGE_IDENTITY_POOL_ID || "";
export const COGNITO_USER_POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID || "";
export const COGNITO_CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || "";

// Module-scope side effect, as before: importing this module is what configures
// Amplify, so every consumer of apiFetch is configured by construction.
if (STORAGE_BUCKET && STORAGE_REGION) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: COGNITO_USER_POOL_ID,
        userPoolClientId: COGNITO_CLIENT_ID,
        identityPoolId: STORAGE_IDENTITY_POOL_ID,
      },
    },
    Storage: {
      S3: {
        bucket: STORAGE_BUCKET,
        region: STORAGE_REGION,
      },
    },
  });
}

export async function authHeaders() {
  try {
    const { tokens } = await fetchAuthSession();
    return tokens?.idToken ? { Authorization: tokens.idToken.toString() } : {};
  } catch {
    return {};
  }
}

// Every call against our API repeats the same four steps: attach the Cognito
// token, send JSON, tolerate a non-JSON body, and throw the API's own error
// message. Doing it once keeps the error contract identical everywhere.
export async function apiFetch(url, {method = "GET", body, errorMessage = "Request failed"} = {}) {
  if (!url) {
    throw new Error("Work API unavailable");
  }
  const headers = await authHeaders();
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || errorMessage);
  }
  return data;
}

export function searchApiUrl(query) {
  if (!SEARCH_API_BASE) return null;
  return `${SEARCH_API_BASE}?q=${encodeURIComponent(query)}`;
}
