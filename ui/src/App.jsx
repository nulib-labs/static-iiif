import {useCallback, useEffect, useState} from "react";
import {Link as RouterLink, useNavigate, useParams} from "react-router-dom";
import {Amplify} from "aws-amplify";
import {fetchAuthSession} from "aws-amplify/auth";
import {list} from "aws-amplify/storage";
import {StorageBrowser} from "./storageBrowser";
import AssetThumbnails from "./components/AssetThumbnails";
import CloverViewer from "@samvera/clover-iiif/viewer";
import {CLOVER_OPTIONS, CLOVER_THEME} from "./cloverTheme";
import {
  Box,
  Flex,
  Card,
  Heading,
  Text,
  Code,
  Link,
  Table,
  Button,
  TextField,
  Dialog,
  Callout,
  Tabs,
} from "@radix-ui/themes";
import "@aws-amplify/ui-react/styles.css";
import "@aws-amplify/ui-react-storage/styles.css";
import "@radix-ui/themes/styles.css";
import "./App.css";

const MANIFEST_API_BASE = (import.meta.env.VITE_MANIFEST_API_URL || "").replace(/\/$/, "");
const IIIF_BASE_URL = (import.meta.env.VITE_IIIF_BASE_URL || "").replace(/\/$/, "");
const STORAGE_BUCKET = import.meta.env.VITE_STORAGE_BUCKET || "";
const SOURCE_BUCKET = import.meta.env.VITE_SOURCE_BUCKET || "";
const STORAGE_REGION = import.meta.env.VITE_STORAGE_REGION || import.meta.env.VITE_AWS_REGION || "";
const STORAGE_IDENTITY_POOL_ID = import.meta.env.VITE_STORAGE_IDENTITY_POOL_ID || "";
const COGNITO_USER_POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID || "";
const COGNITO_CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || "";

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

async function authHeaders() {
  try {
    const { tokens } = await fetchAuthSession();
    return tokens?.idToken ? { Authorization: tokens.idToken.toString() } : {};
  } catch {
    return {};
  }
}

function slugifyManifestId(value) {
  return (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildInfoUrlFromKey(key) {
  if (!IIIF_BASE_URL || !key) return "";
  const identifier = key.replace(/\.[^./]+$/, "");
  return `${IIIF_BASE_URL}/${encodeURIComponent(identifier)}/info.json`;
}

function assetLabelFromKey(key) {
  const basename = (key || "").split("/").filter(Boolean).pop() || "";
  return basename.replace(/\.[^./]+$/, "");
}

function buildCanvasResource(manifest, imageInfo, label) {
  if (!manifest?.id) {
    throw new Error("Work is missing an id");
  }
  // serverless-iiif currently serves IIIF Image API 2.1 (`@context`/`@id`), not 3.x (`id`) — support both.
  const imageId = imageInfo?.id || imageInfo?.["@id"];
  if (!imageId) {
    throw new Error("Image info is missing an id");
  }
  const isImageApi2 =
    /\/image\/2\//.test(imageInfo?.["@context"] || "") || (!imageInfo?.id && Boolean(imageInfo?.["@id"]));
  const manifestBase = manifest.id.replace(/\/manifest\.json$/i, "");
  const normalizedLabel = label?.trim() || "Asset";
  const slugBase = slugifyManifestId(normalizedLabel) || slugifyManifestId(imageId.split("/").pop() || "");
  const uniqueSlug = slugBase ? `${slugBase}-${Date.now().toString(36)}` : Date.now().toString(36);
  const canvasId = `${manifestBase}/canvas/${uniqueSlug}`;
  const pageId = `${canvasId}/page/1`;
  const annotationId = `${canvasId}/annotation/1`;
  const serviceId = imageId.replace(/\/$/, "");
  const imageService = {
    id: serviceId,
    type: imageInfo.type || (isImageApi2 ? "ImageService2" : "ImageService3"),
    profile: Array.isArray(imageInfo.profile)
      ? imageInfo.profile[0]
      : imageInfo.profile || "level0",
    width: imageInfo.width,
    height: imageInfo.height,
  };
  const canvas = {
    id: canvasId,
    type: "Canvas",
    width: imageInfo.width,
    height: imageInfo.height,
    items: [
      {
        id: pageId,
        type: "AnnotationPage",
        items: [
          {
            id: annotationId,
            type: "Annotation",
            motivation: "painting",
            target: canvasId,
            body: {
              id: `${serviceId}/full/${isImageApi2 ? "full" : "max"}/0/default.jpg`,
              type: "Image",
              format: "image/jpeg",
              width: imageInfo.width,
              height: imageInfo.height,
              service: [imageService],
            },
          },
        ],
      },
    ],
  };
  if (normalizedLabel) {
    canvas.label = {none: [normalizedLabel]};
  }
  return canvas;
}

function StorageBrowserPanel({ready}) {
  return (
    <Card size="3" className="panel storage-panel">
      <Heading as="h2" size="4" mb="3">S3 Storage Browser</Heading>
      <Box className="panel-body storage-panel-body">
        {ready ? (
          <Box className="storage-browser-wrapper">
            <StorageBrowser />
          </Box>
        ) : (
          <Text as="p" size="2" color="gray">
            Provide `VITE_STORAGE_BUCKET`, `VITE_SOURCE_BUCKET`, and
            `VITE_STORAGE_REGION` to enable the Amplify Storage Browser.
          </Text>
        )}
      </Box>
    </Card>
  );
}

function ManifestList({manifests, selectedId}) {
  const [previewManifest, setPreviewManifest] = useState(null);

  if (!manifests || manifests.length === 0) {
    return <Text as="p" size="2" color="gray" className="tree-empty">No works yet.</Text>;
  }

  return (
    <>
      <Table.Root variant="surface" className="manifest-list">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>ID</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Title</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Assets</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell></Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {manifests.map((manifest) => {
            const isActive = manifest.identifier === selectedId;
            const canvasCount = Number.isFinite(manifest.itemCount)
              ? manifest.itemCount
              : Array.isArray(manifest.manifest?.items)
                ? manifest.manifest.items.length
                : 0;
            return (
              <Table.Row
                key={manifest.identifier}
                className={`manifest-list-row ${isActive ? "manifest-list-row--active" : ""}`}
              >
                <Table.RowHeaderCell>
                  <Code size="2" color="gray" variant="ghost" style={{fontSize: "var(--font-size-2)"}}>
                    {manifest.identifier}
                  </Code>
                </Table.RowHeaderCell>
                <Table.Cell>
                  <Link asChild size="2" weight="bold">
                    <RouterLink to={`/works/${encodeURIComponent(manifest.identifier)}`}>
                      {manifest.label || manifest.identifier}
                    </RouterLink>
                  </Link>
                </Table.Cell>
                <Table.Cell className="assets-cell">
                  <AssetThumbnails
                    services={manifest.thumbnails}
                    size={32}
                    stacked
                    count={canvasCount}
                  />
                </Table.Cell>
                <Table.Cell>
                  <Flex gap="3" justify="end" className="manifest-row-actions">
                    <Link asChild size="2">
                      <RouterLink to={`/works/${encodeURIComponent(manifest.identifier)}`}>
                        Edit
                      </RouterLink>
                    </Link>
                    <Link asChild size="2">
                      <button type="button" onClick={() => setPreviewManifest(manifest)}>
                        Preview
                      </button>
                    </Link>
                    <Link asChild size="2">
                      <a href={manifest.manifestUrl} target="_blank" rel="noreferrer">
                        IIIF
                      </a>
                    </Link>
                  </Flex>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
      <Dialog.Root open={Boolean(previewManifest)} onOpenChange={(open) => !open && setPreviewManifest(null)}>
        <Dialog.Content maxWidth="800px">
          <Dialog.Title>{previewManifest?.label || previewManifest?.identifier}</Dialog.Title>
          {previewManifest && (
            <Box className="viewer-stage" style={{width: "100%"}}>
              <CloverViewer
                key={previewManifest.identifier}
                iiifContent={previewManifest.manifestUrl}
                customTheme={CLOVER_THEME}
                options={CLOVER_OPTIONS}
              />
            </Box>
          )}
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

function ManifestDetail({
  detail,
  loading,
  error,
  onAddCanvas,
  canAddCanvas,
  onReorderCanvas,
  onRemoveCanvas,
  canvasSaving,
  canvasActionError,
  disableAddReason,
}) {
  if (loading) {
    return <Text as="p" color="gray" className="manifest-detail-placeholder">Loading work…</Text>;
  }

  if (error) {
    return (
      <Callout.Root color="red" size="1">
        <Callout.Text>{error}</Callout.Text>
      </Callout.Root>
    );
  }

  if (!detail) {
    return <Text as="p" color="gray" className="manifest-detail-placeholder">Select a work to edit assets.</Text>;
  }

  const canvases = Array.isArray(detail.manifest?.items)
    ? detail.manifest.items
    : [];

  return (
    <Box className="manifest-detail">
      <Flex justify="between" align="start" gap="3" className="manifest-detail-header">
        <Box className="manifest-detail-meta">
          <Heading as="h3" size="3" mb="1">{detail.label || detail.identifier}</Heading>
          <Text as="p" size="1" className="manifest-detail-meta-url">{detail.manifestUrl}</Text>
        </Box>
        <Button
          type="button"
          onClick={onAddCanvas}
          disabled={!canAddCanvas}
          title={!canAddCanvas && disableAddReason ? disableAddReason : undefined}
        >
          Add Asset
        </Button>
      </Flex>
      {disableAddReason && !canAddCanvas && (
        <Text as="p" size="1" color="gray" className="manifest-detail-hint">{disableAddReason}</Text>
      )}
      {canvasActionError && (
        <Callout.Root color="red" size="1">
          <Callout.Text>{canvasActionError}</Callout.Text>
        </Callout.Root>
      )}
      {canvasSaving && (
        <Callout.Root color="iris" size="1">
          <Callout.Text>Saving assets…</Callout.Text>
        </Callout.Root>
      )}
      <Box className="manifest-detail-body">
        {canvases.length === 0 ? (
          <Text as="p" size="2">
            {canAddCanvas
              ? "No assets yet. Add one to start building the viewing order."
              : "No assets yet."}
          </Text>
        ) : (
          <Flex direction="column" gap="2" className="canvas-list">
            {canvases.map((canvas, index) => (
              <Card key={canvas.id || `${index}`} className="canvas-list-item">
                <Flex justify="between" align="center" gap="3">
                  <Box className="canvas-list-info">
                    <Text as="p" weight="bold" size="2">{canvas.label?.none?.[0] || `Asset ${index + 1}`}</Text>
                    <Text as="p" size="1" color="gray">
                      {canvas.items?.[0]?.items?.[0]?.body?.service?.[0]?.id ||
                        canvas.items?.[0]?.items?.[0]?.body?.id ||
                        ""}
                    </Text>
                  </Box>
                  <Flex gap="2" className="canvas-list-actions">
                    <Button
                      type="button"
                      variant="soft"
                      size="1"
                      onClick={() => onReorderCanvas(index, -1)}
                      disabled={index === 0 || canvasSaving}
                      aria-label="Move up"
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="soft"
                      size="1"
                      onClick={() => onReorderCanvas(index, 1)}
                      disabled={index === canvases.length - 1 || canvasSaving}
                      aria-label="Move down"
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      variant="soft"
                      color="red"
                      size="1"
                      onClick={() => onRemoveCanvas(index)}
                      disabled={canvasSaving}
                    >
                      Remove
                    </Button>
                  </Flex>
                </Flex>
              </Card>
            ))}
          </Flex>
        )}
      </Box>
    </Box>
  );
}

function ManifestModal({open, onClose, onSubmit, form, onChange, submitting, error}) {
  const handleChange = (evt) => {
    const {name, value} = evt.target;
    onChange(name, value);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Content maxWidth="420px">
        <Dialog.Title>Create Work</Dialog.Title>
        <form onSubmit={onSubmit}>
          <Flex direction="column" gap="3">
            <label>
              <Text as="div" size="2" weight="medium" mb="1">Title (label)</Text>
              <TextField.Root
                name="label"
                type="text"
                required
                value={form.label}
                onChange={handleChange}
                placeholder="e.g. 1973 yearbook"
              />
            </label>
            <label>
              <Text as="div" size="2" weight="medium" mb="1">ID</Text>
              <TextField.Root
                name="identifier"
                type="text"
                required
                value={form.identifier}
                onChange={handleChange}
                placeholder="e.g. 1973-yearbook"
              />
            </label>
            {error && (
              <Callout.Root color="red" size="1">
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            )}
            <Flex justify="end" gap="3" mt="2">
              <Button type="button" variant="soft" color="gray" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Next"}
              </Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function AssetImagePicker({value, onSelect, disabled}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    list({path: "image/"})
      .then((result) => {
        if (cancelled) return;
        const files = (result.items || []).filter(
          (item) => item.path && !item.path.endsWith("/"),
        );
        setItems(files);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || "Unable to list images");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <Text as="p" size="2" color="gray">Loading images…</Text>;
  }

  if (error) {
    return (
      <Callout.Root color="red" size="1">
        <Callout.Text>{error}</Callout.Text>
      </Callout.Root>
    );
  }

  if (items.length === 0) {
    return <Text as="p" size="2" color="gray">No images found in `image/`.</Text>;
  }

  return (
    <Flex direction="column" gap="1" className="asset-picker-list">
      {items.map((item) => {
        const isActive = item.path === value;
        return (
          <Card
            key={item.path}
            asChild
            variant={isActive ? "classic" : "surface"}
            className={`asset-picker-item ${isActive ? "asset-picker-item--active" : ""}`}
          >
            <button
              type="button"
              onClick={() => onSelect(item.path)}
              disabled={disabled}
            >
              <Text size="2">{item.path.replace(/^image\//, "")}</Text>
            </button>
          </Card>
        );
      })}
    </Flex>
  );
}

function AddCanvasModal({open, onClose, onSubmit, form, onChange, submitting, error}) {
  const handleChange = (evt) => {
    const {name, value} = evt.target;
    onChange(name, value);
  };
  const resolvedUrl = buildInfoUrlFromKey(form.assetKey);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Content maxWidth="420px">
        <Dialog.Title>Add Asset</Dialog.Title>
        <form onSubmit={onSubmit}>
          <Flex direction="column" gap="3">
            {!IIIF_BASE_URL && (
              <Callout.Root color="red" size="1">
                <Callout.Text>
                  VITE_IIIF_BASE_URL is not configured; asset URLs cannot be resolved.
                </Callout.Text>
              </Callout.Root>
            )}
            <label>
              <Text as="div" size="2" weight="medium" mb="1">Select an image asset</Text>
              <AssetImagePicker
                value={form.assetKey}
                onSelect={(key) => onChange("assetKey", key)}
                disabled={submitting}
              />
            </label>
            {form.assetKey && (
              <Text as="p" size="1" color="gray" className="asset-picker-resolved-url">
                {resolvedUrl || "Unable to resolve a URL for this asset."}
              </Text>
            )}
            <label>
              <Text as="div" size="2" weight="medium" mb="1">Asset label</Text>
              <TextField.Root
                name="label"
                type="text"
                value={form.label}
                onChange={handleChange}
                placeholder="e.g. Page 1"
                disabled={submitting}
              />
            </label>
            {error && (
              <Callout.Root color="red" size="1">
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            )}
            <Flex justify="end" gap="3" mt="2">
              <Button type="button" variant="soft" color="gray" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting || !form.assetKey || !resolvedUrl}>
                {submitting ? "Adding…" : "Add"}
              </Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function WorksListPanel({
  manifestApiAvailable,
  manifestError,
  manifestLoading,
  manifests,
  selectedManifestId,
  onOpenManifestModal,
}) {
  return (
    <Flex direction="column" gap="5">
      <Card size="3" className="panel manifest-panel">
        <Flex justify="between" align="center" gap="3" mb="4">
          <TextField.Root size="3" placeholder="Search works…" style={{flex: 1}} />
          <Button
            type="button"
            size="3"
            onClick={onOpenManifestModal}
            disabled={!manifestApiAvailable}
          >
            Add Work
          </Button>
        </Flex>
        <Box className="panel-body manifest-panel-body">
          {!manifestApiAvailable && (
            <Callout.Root color="red" size="1" mb="3">
              <Callout.Text>
                Work API URL is not configured. Update VITE_MANIFEST_API_URL to point at the deployed endpoint.
              </Callout.Text>
            </Callout.Root>
          )}
          {manifestError && manifestApiAvailable && (
            <Callout.Root color="red" size="1" mb="3">
              <Callout.Text>{manifestError}</Callout.Text>
            </Callout.Root>
          )}
          {manifestLoading ? (
            <Text as="p" size="2" color="gray">Loading works…</Text>
          ) : (
            <ManifestList
              manifests={manifests}
              selectedId={selectedManifestId}
            />
          )}
        </Box>
      </Card>
    </Flex>
  );
}

function WorkDetailPanel({
  manifestDetail,
  manifestDetailLoading,
  manifestDetailError,
  onAddCanvas,
  canAddCanvas,
  onReorderCanvas,
  onRemoveCanvas,
  canvasSaving,
  canvasActionError,
  disableAddReason,
}) {
  return (
    <Flex direction="column" gap="5">
      {manifestDetail && (
        <Flex direction="column" gap="1">
          <Heading as="h1" size="6">{manifestDetail.label || manifestDetail.identifier}</Heading>
          <Flex align="center" gap="2" style={{fontFamily: "var(--code-font-family)", fontSize: "var(--font-size-2)"}}>
            <Link asChild underline="always">
              <RouterLink to="/works">works</RouterLink>
            </Link>
            <Text style={{color: "var(--gray-8)"}}>/</Text>
            <Text color="gray">{manifestDetail.identifier}</Text>
          </Flex>
        </Flex>
      )}
      <Card size="3" className="panel viewer-panel">
        {manifestDetailLoading ? (
          <Text as="p" color="gray" className="viewer-placeholder">Loading work…</Text>
        ) : manifestDetail ? (
          <Flex direction="column" gap="3" className="viewer">
            <Box
              className="viewer-stage"
              style={{width: "100%"}}
            >
              <CloverViewer
                key={manifestDetail.identifier}
                iiifContent={manifestDetail.manifest}
                customTheme={CLOVER_THEME}
                options={CLOVER_OPTIONS}
              />
            </Box>
          </Flex>
        ) : (
          <Text as="p" color="gray" className="viewer-placeholder">
            Select a work above to preview it here.
          </Text>
        )}
        {manifestDetailError && (
          <Callout.Root color="red" size="1" mt="3">
            <Callout.Text>{manifestDetailError}</Callout.Text>
          </Callout.Root>
        )}
      </Card>
      <Card size="3" className="panel manifest-panel">
        <Box className="panel-body manifest-panel-body">
          <ManifestDetail
            detail={manifestDetail}
            loading={manifestDetailLoading}
            error={manifestDetailError}
            onAddCanvas={onAddCanvas}
            canAddCanvas={canAddCanvas}
            onReorderCanvas={onReorderCanvas}
            onRemoveCanvas={onRemoveCanvas}
            canvasSaving={canvasSaving}
            canvasActionError={canvasActionError}
            disableAddReason={disableAddReason}
          />
        </Box>
      </Card>
    </Flex>
  );
}

export default function App({ signOut }) {
  const {tab, workId} = useParams();
  const navigate = useNavigate();
  const activeTab = tab === "assets" ? "assets" : "works";
  const selectedManifestId = activeTab === "works" && workId ? decodeURIComponent(workId) : null;

  const selectWork = useCallback(
    (identifier) => {
      navigate(identifier ? `/works/${encodeURIComponent(identifier)}` : "/works");
    },
    [navigate],
  );

  useEffect(() => {
    if (tab !== "works" && tab !== "assets") {
      navigate("/works", {replace: true});
    }
  }, [tab, navigate]);

  const manifestApiAvailable = Boolean(MANIFEST_API_BASE);
  const storageBrowserReady = Boolean(STORAGE_BUCKET && SOURCE_BUCKET && STORAGE_REGION);
  const [manifests, setManifests] = useState([]);
  const [manifestLoading, setManifestLoading] = useState(manifestApiAvailable);
  const [manifestError, setManifestError] = useState(null);
  const [manifestDetail, setManifestDetail] = useState(null);
  const [manifestDetailLoading, setManifestDetailLoading] = useState(false);
  const [manifestDetailError, setManifestDetailError] = useState(null);
  const [isManifestModalOpen, setManifestModalOpen] = useState(false);
  const [manifestForm, setManifestForm] = useState({label: "", identifier: ""});
  const [manifestFormError, setManifestFormError] = useState(null);
  const [manifestFormSubmitting, setManifestFormSubmitting] = useState(false);
  const [isCanvasModalOpen, setCanvasModalOpen] = useState(false);
  const [canvasForm, setCanvasForm] = useState({assetKey: "", label: ""});
  const [canvasModalError, setCanvasModalError] = useState(null);
  const [canvasModalSubmitting, setCanvasModalSubmitting] = useState(false);
  const [canvasSaving, setCanvasSaving] = useState(false);
  const [canvasActionError, setCanvasActionError] = useState(null);

  const manifestApiUrl = useCallback(
    (path = "") => {
      if (!MANIFEST_API_BASE) return null;
      const suffix = path ? `/${path.replace(/^\/+/, "")}` : "";
      return `${MANIFEST_API_BASE}${suffix}`;
    },
    [],
  );

  const refreshManifests = useCallback(async () => {
    if (!manifestApiAvailable) {
      setManifests([]);
      setManifestError("Work API URL is not configured. Set VITE_MANIFEST_API_URL and redeploy.");
      setManifestLoading(false);
      return;
    }
    setManifestLoading(true);
    setManifestError(null);
    try {
      const endpoint = manifestApiUrl();
      if (!endpoint) {
        throw new Error("Work API unavailable");
      }
      const response = await fetch(endpoint, { headers: await authHeaders() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to load works");
      }
      setManifests(Array.isArray(data.manifests) ? data.manifests : []);
    } catch (err) {
      setManifests([]);
      setManifestError(err.message);
    } finally {
      setManifestLoading(false);
    }
  }, [manifestApiAvailable, manifestApiUrl]);

  const fetchManifestDetail = useCallback(async (identifier) => {
    if (!identifier || !manifestApiAvailable) {
      setManifestDetail(null);
      return;
    }
    setManifestDetailLoading(true);
    setManifestDetailError(null);
    try {
      const endpoint = manifestApiUrl(encodeURIComponent(identifier));
      if (!endpoint) {
        throw new Error("Work API unavailable");
      }
      const response = await fetch(endpoint, { headers: await authHeaders() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to load work");
      }
      setManifestDetail(data.manifest);
      setManifests((prev) =>
        prev.map((manifest) =>
          manifest.identifier === identifier
            ? {...manifest, itemCount: data.manifest?.itemCount ?? manifest.itemCount}
            : manifest,
        ),
      );
    } catch (err) {
      setManifestDetail(null);
      setManifestDetailError(err.message);
    } finally {
      setManifestDetailLoading(false);
    }
  }, [manifestApiAvailable, manifestApiUrl]);

  const handleManifestFieldChange = useCallback((name, value) => {
    setManifestForm((prev) => {
      if (name === "label") {
        const fallbackId = prev.identifier.trim() ? prev.identifier : slugifyManifestId(value);
        return {...prev, label: value, identifier: fallbackId};
      }
      return {...prev, [name]: value};
    });
  }, []);

  const handleCanvasFieldChange = useCallback((name, value) => {
    setCanvasForm((prev) => ({...prev, [name]: value}));
  }, []);

  const handleOpenManifestModal = () => {
    if (!manifestApiAvailable) return;
    setManifestForm({label: "", identifier: ""});
    setManifestFormError(null);
    setManifestModalOpen(true);
  };

  const handleCloseManifestModal = () => {
    setManifestModalOpen(false);
    setManifestFormError(null);
  };

  const handleManifestSubmit = async (event) => {
    event.preventDefault();
    const payload = {
      label: manifestForm.label.trim(),
      identifier: manifestForm.identifier.trim(),
    };
    if (!payload.label || !payload.identifier) {
      setManifestFormError("Both label and id are required");
      return;
    }
    setManifestFormSubmitting(true);
    setManifestFormError(null);
    try {
      const endpoint = manifestApiUrl();
      if (!endpoint) {
        throw new Error("Work API unavailable");
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {"Content-Type": "application/json", ...(await authHeaders())},
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to create work");
      }
      await refreshManifests();
      selectWork(data.manifest?.identifier || payload.identifier);
      setManifestModalOpen(false);
    } catch (err) {
      setManifestFormError(err.message);
    } finally {
      setManifestFormSubmitting(false);
    }
  };

  const handleOpenCanvasModal = () => {
    if (!manifestDetail) return;
    setCanvasForm((prev) => ({assetKey: prev.assetKey || "", label: prev.label || ""}));
    setCanvasModalError(null);
    setCanvasModalOpen(true);
  };

  const handleCloseCanvasModal = () => {
    setCanvasModalOpen(false);
    setCanvasModalError(null);
  };

  const persistManifestItems = useCallback(
    async (items) => {
      if (!selectedManifestId) {
        throw new Error("Select a work first");
      }
      setCanvasSaving(true);
      setCanvasActionError(null);
      try {
        const endpoint = manifestApiUrl(`${encodeURIComponent(selectedManifestId)}/items`);
        if (!endpoint) {
          throw new Error("Work API unavailable");
        }
        const response = await fetch(endpoint, {
          method: "PUT",
          headers: {"Content-Type": "application/json", ...(await authHeaders())},
          body: JSON.stringify({items}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "Unable to save assets");
        }
        setManifestDetail(data.manifest);
        setManifests((prev) =>
          prev.map((manifest) =>
            manifest.identifier === selectedManifestId
              ? {...manifest, itemCount: data.manifest.itemCount}
              : manifest,
          ),
        );
        return data.manifest;
      } catch (err) {
        setCanvasActionError(err.message);
        throw err;
      } finally {
        setCanvasSaving(false);
      }
    },
    [manifestApiUrl, selectedManifestId],
  );

  const handleCanvasSubmit = async (event) => {
    event.preventDefault();
    if (!manifestDetail?.manifest) {
      setCanvasModalError("Select a work first");
      return;
    }
    setCanvasModalSubmitting(true);
    setCanvasModalError(null);
    try {
      const infoUrl = buildInfoUrlFromKey(canvasForm.assetKey);
      if (!infoUrl) {
        setCanvasModalError("Select an image asset");
        setCanvasModalSubmitting(false);
        return;
      }
      const response = await fetch(infoUrl);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to load image info");
      }
      const label = canvasForm.label.trim() || assetLabelFromKey(canvasForm.assetKey) || "Untitled asset";
      const nextCanvas = buildCanvasResource(manifestDetail.manifest, data, label);
      const nextItems = [...(manifestDetail.manifest.items || []), nextCanvas];
      await persistManifestItems(nextItems);
      setCanvasModalOpen(false);
      setCanvasForm({assetKey: "", label: ""});
    } catch (err) {
      setCanvasModalError(err.message);
    } finally {
      setCanvasModalSubmitting(false);
    }
  };

  const handleReorderCanvas = useCallback(
    async (index, delta) => {
      if (!manifestDetail?.manifest?.items) return;
      const items = [...manifestDetail.manifest.items];
      const targetIndex = index + delta;
      if (targetIndex < 0 || targetIndex >= items.length) return;
      [items[index], items[targetIndex]] = [items[targetIndex], items[index]];
      try {
        await persistManifestItems(items);
      } catch (err) {
        // Error handled via canvasActionError state.
      }
    },
    [manifestDetail, persistManifestItems],
  );

  const handleRemoveCanvas = useCallback(
    async (index) => {
      if (!manifestDetail?.manifest?.items) return;
      const items = manifestDetail.manifest.items.filter((_, idx) => idx !== index);
      try {
        await persistManifestItems(items);
      } catch (err) {
        // Error handled via canvasActionError state.
      }
    },
    [manifestDetail, persistManifestItems],
  );

  useEffect(() => {
    if (!manifestApiAvailable) return;
    refreshManifests();
  }, [manifestApiAvailable, refreshManifests]);

  useEffect(() => {
    if (!manifestApiAvailable) {
      setManifestDetail(null);
      setCanvasActionError(null);
      return;
    }
    if (!selectedManifestId) {
      setManifestDetail(null);
      setCanvasActionError(null);
      return;
    }
    fetchManifestDetail(selectedManifestId);
  }, [fetchManifestDetail, manifestApiAvailable, selectedManifestId]);

  const canAddCanvas = Boolean(manifestDetail) && manifestApiAvailable;
  const disableAddReason = (() => {
    if (!manifestDetail) return null;
    if (!manifestApiAvailable) {
      return "Work API unavailable.";
    }
    return null;
  })();

  return (
    <main className="layout">
      <Flex direction="column" gap="2" className="layout-header">
        <Flex justify="between" align="start" gap="3">
          <Box>
            <Heading as="h1" size="7">Static IIIF Dashboard</Heading>
            <Text as="p" color="gray">
              Manage works and browse image assets.
            </Text>
          </Box>
          {signOut && (
            <Button type="button" variant="soft" color="gray" onClick={signOut}>
              Sign out
            </Button>
          )}
        </Flex>
      </Flex>
      <Tabs.Root value={activeTab} onValueChange={(value) => value !== activeTab && navigate(`/${value}`)}>
        <Tabs.List size="2" className="tabs-large">
          <Tabs.Trigger value="works">Works</Tabs.Trigger>
          <Tabs.Trigger value="assets">Assets</Tabs.Trigger>
        </Tabs.List>
        <Box pt="5">
          <Tabs.Content value="works">
            {selectedManifestId ? (
              <WorkDetailPanel
                manifestDetail={manifestDetail}
                manifestDetailLoading={manifestDetailLoading}
                manifestDetailError={manifestDetailError}
                onAddCanvas={handleOpenCanvasModal}
                canAddCanvas={canAddCanvas}
                onReorderCanvas={handleReorderCanvas}
                onRemoveCanvas={handleRemoveCanvas}
                canvasSaving={canvasSaving}
                canvasActionError={canvasActionError}
                disableAddReason={disableAddReason}
              />
            ) : (
              <WorksListPanel
                manifestApiAvailable={manifestApiAvailable}
                manifestError={manifestError}
                manifestLoading={manifestLoading}
                manifests={manifests}
                selectedManifestId={selectedManifestId}
                onOpenManifestModal={handleOpenManifestModal}
              />
            )}
          </Tabs.Content>
          <Tabs.Content value="assets">
            <div className="columns">
              <StorageBrowserPanel ready={storageBrowserReady} />
            </div>
          </Tabs.Content>
        </Box>
      </Tabs.Root>
      <ManifestModal
        open={isManifestModalOpen}
        onClose={handleCloseManifestModal}
        onSubmit={handleManifestSubmit}
        form={manifestForm}
        onChange={handleManifestFieldChange}
        submitting={manifestFormSubmitting}
        error={manifestFormError}
      />
      <AddCanvasModal
        open={isCanvasModalOpen}
        onClose={handleCloseCanvasModal}
        onSubmit={handleCanvasSubmit}
        form={canvasForm}
        onChange={handleCanvasFieldChange}
        submitting={canvasModalSubmitting}
        error={canvasModalError}
      />
    </main>
  );
}
