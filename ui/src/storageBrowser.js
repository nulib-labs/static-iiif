import { createStorageBrowser } from "@aws-amplify/ui-react-storage/browser";
import { fetchAuthSession } from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";

const STORAGE_BUCKET = import.meta.env.VITE_STORAGE_BUCKET || "";
const STORAGE_REGION =
  import.meta.env.VITE_STORAGE_REGION ||
  import.meta.env.VITE_AWS_REGION ||
  "";

// Locations available in the Storage Browser.
// Add new entries here as new workflows require access to additional prefixes/buckets.
const LOCATIONS = [
  {
    id: "iiif-images",
    bucket: STORAGE_BUCKET,
    prefix: "image/",
    permissions: ["list", "get"],
    type: "PREFIX",
  },
  // TODO: manifest browsing/editing
  // {
  //   id: "iiif-manifests",
  //   bucket: STORAGE_BUCKET,
  //   prefix: "presentation/manifest/",
  //   permissions: ["list", "get", "write", "delete"],
  //   type: "PREFIX",
  // },
  // TODO: source image upload (requires VITE_SOURCE_BUCKET env var)
  // {
  //   id: "source-images",
  //   bucket: import.meta.env.VITE_SOURCE_BUCKET || "",
  //   prefix: "image/",
  //   permissions: ["list", "get", "write"],
  //   type: "PREFIX",
  // },
];

export const { StorageBrowser } = createStorageBrowser({
  config: {
    region: STORAGE_REGION,
    listLocations: async () => ({ items: LOCATIONS, nextToken: undefined }),
    getLocationCredentials: async () => {
      const { credentials, identityId } = await fetchAuthSession();
      return { credentials, identityId };
    },
    registerAuthListener: (onStateChange) => {
      const remove = Hub.listen("auth", ({ payload }) => {
        if (payload.event === "signedOut") {
          onStateChange();
          remove();
        }
      });
    },
  },
});
