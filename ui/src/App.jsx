import {useCallback, useEffect, useMemo, useState} from "react";
import {Link as RouterLink, useNavigate, useParams} from "react-router-dom";
import {Amplify} from "aws-amplify";
import {fetchAuthSession} from "aws-amplify/auth";
import {StorageBrowser} from "./storageBrowser";
import AssetThumbnails from "./components/AssetThumbnails";
import AssetDropzone from "./components/AssetDropzone";
import CloverViewer from "@samvera/clover-iiif/viewer";
import {CLOVER_OPTIONS, CLOVER_THEME} from "./cloverTheme";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  TrashIcon,
  ZoomInIcon,
} from "@radix-ui/react-icons";
import {
  Box,
  Flex,
  Card,
  Heading,
  Text,
  Link,
  Table,
  Button,
  IconButton,
  Tooltip,
  TextField,
  Dialog,
  AlertDialog,
  Callout,
  Badge,
  Progress,
  Tabs,
} from "@radix-ui/themes";
import "@aws-amplify/ui-react/styles.css";
import "@aws-amplify/ui-react-storage/styles.css";
import "@radix-ui/themes/styles.css";
import "./App.css";

const MANIFEST_API_BASE = (import.meta.env.VITE_MANIFEST_API_URL || "").replace(/\/$/, "");
const SEARCH_API_BASE = (import.meta.env.VITE_SEARCH_API_URL || "").replace(/\/$/, "");
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

// Every call against our API repeats the same four steps: attach the Cognito
// token, send JSON, tolerate a non-JSON body, and throw the API's own error
// message. Doing it once keeps the error contract identical everywhere.
async function apiFetch(url, {method = "GET", body, errorMessage = "Request failed"} = {}) {
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

function searchApiUrl(query) {
  if (!SEARCH_API_BASE) return null;
  return `${SEARCH_API_BASE}?q=${encodeURIComponent(query)}`;
}

// The search index only stores the manifest's own id (its full URL), not this app's
// route — parse the identifier back out of the known presentation/manifest/<id>/manifest.json
// suffix rather than having the backend bake in app-specific routing.
function identifierFromManifestId(manifestUrl) {
  const match = /presentation\/manifest\/([^/]+)\/manifest\.json$/.exec(manifestUrl || "");
  return match ? match[1] : null;
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

function ManifestList({manifests, selectedId, onDelete}) {
  const [previewManifest, setPreviewManifest] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const handleConfirmDelete = async (event) => {
    event.preventDefault();
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(pendingDelete.identifier);
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  if (!manifests || manifests.length === 0) {
    return <Text as="p" size="2" color="gray" className="tree-empty">No works yet.</Text>;
  }

  return (
    <>
      <Table.Root variant="surface" className="manifest-list">
        <Table.Header>
          <Table.Row>
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
                  <Link asChild size="2" weight="bold">
                    <RouterLink to={`/works/${encodeURIComponent(manifest.identifier)}`}>
                      {manifest.label || manifest.identifier}
                    </RouterLink>
                  </Link>
                </Table.RowHeaderCell>
                <Table.Cell className="assets-cell">
                  <AssetThumbnails
                    services={manifest.thumbnails}
                    size={32}
                    max={5}
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
                    <Button variant="ghost" size="2" onClick={() => setPreviewManifest(manifest)}>
                      Preview
                    </Button>
                    <Link asChild size="2">
                      <a href={manifest.manifestUrl} target="_blank" rel="noreferrer">
                        IIIF
                      </a>
                    </Link>
                    <Button
                      variant="ghost"
                      size="2"
                      color="red"
                      onClick={() => {
                        setDeleteError(null);
                        setPendingDelete(manifest);
                      }}
                    >
                      Delete
                    </Button>
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
      <AlertDialog.Root
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialog.Content maxWidth="480px">
          <AlertDialog.Title>Delete work?</AlertDialog.Title>
          <AlertDialog.Description size="2">
            This permanently deletes “{pendingDelete?.label || pendingDelete?.identifier}”, its manifest,
            every source image and IIIF-generated derivative it references. This cannot be undone.
          </AlertDialog.Description>
          {deleteError && (
            <Callout.Root color="red" size="1" mt="3">
              <Callout.Text>{deleteError}</Callout.Text>
            </Callout.Root>
          )}
          <Flex justify="end" gap="3" mt="4">
            <AlertDialog.Cancel>
              <Button type="button" variant="soft" color="gray" disabled={deleting}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button type="button" color="red" onClick={handleConfirmDelete} loading={deleting}>
              Delete
            </Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}

function SearchResultsList({results, loading, error}) {
  if (loading) {
    return <Text as="p" size="2" color="gray">Searching…</Text>;
  }

  if (error) {
    return (
      <Callout.Root color="red" size="1">
        <Callout.Text>{error}</Callout.Text>
      </Callout.Root>
    );
  }

  if (!results || results.length === 0) {
    return <Text as="p" size="2" color="gray" className="tree-empty">No matching works.</Text>;
  }

  return (
    <Table.Root variant="surface" className="manifest-list">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeaderCell>Title</Table.ColumnHeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {results.map((hit) => {
          const identifier = identifierFromManifestId(hit.manifestId);
          return (
            <Table.Row key={hit.id}>
              <Table.Cell>
                {identifier ? (
                  <Link asChild size="2" weight="bold">
                    <RouterLink to={`/works/${encodeURIComponent(identifier)}`}>
                      {hit.title || identifier}
                    </RouterLink>
                  </Link>
                ) : (
                  <Text size="2">{hit.title || hit.manifestId}</Text>
                )}
              </Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table.Root>
  );
}

function ManifestDetail({
  detail,
  loading,
  error,
  onAttachAssets,
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
      <Flex direction="column" gap="1" className="manifest-detail-header">
        <Heading as="h3" size="3" mb="1">{detail.label || detail.identifier}</Heading>
        <Text as="p" size="1" className="manifest-detail-meta-url">{detail.manifestUrl}</Text>
      </Flex>
      <AssetDropzone
        workId={detail.identifier}
        manifest={detail.manifest}
        disabled={!canAddCanvas}
        disabledReason={disableAddReason}
        onAttach={onAttachAssets}
      />
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
                    <Tooltip content="Move up">
                      <IconButton
                        type="button"
                        variant="soft"
                        size="1"
                        onClick={() => onReorderCanvas(index, -1)}
                        disabled={index === 0 || canvasSaving}
                        aria-label="Move up"
                      >
                        <ArrowUpIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip content="Move down">
                      <IconButton
                        type="button"
                        variant="soft"
                        size="1"
                        onClick={() => onReorderCanvas(index, 1)}
                        disabled={index === canvases.length - 1 || canvasSaving}
                        aria-label="Move down"
                      >
                        <ArrowDownIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip content="Remove asset">
                      <IconButton
                        type="button"
                        variant="soft"
                        color="red"
                        size="1"
                        onClick={() => onRemoveCanvas(index)}
                        disabled={canvasSaving}
                        aria-label="Remove asset"
                      >
                        <TrashIcon />
                      </IconButton>
                    </Tooltip>
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

function AddWorkModal({
  open,
  onClose,
  step,
  onSelectStep,
  onBack,
  createForm,
  onCreateChange,
  onCreateSubmit,
  createSubmitting,
  createError,
  importUrl,
  onImportUrlChange,
  onImportFetch,
  importFetching,
  importError,
  importPreview,
  onImportConfirm,
  importConfirming,
}) {
  const [showImportViewer, setShowImportViewer] = useState(false);
  const [importViewerContent, setImportViewerContent] = useState(null);

  const handleCreateChange = (evt) => {
    onCreateChange(evt.target.name, evt.target.value);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Content maxWidth="560px">
        {step === "choose" && (
          <>
            <Dialog.Title>Add Work</Dialog.Title>
            <Flex direction="column" gap="3">
              <Card asChild variant="surface" className="add-work-option">
                <button type="button" onClick={() => onSelectStep("import-url")}>
                  <Flex direction="column" gap="1">
                    <Text weight="medium">Import Works</Text>
                    <Text size="2" color="gray">Bring in an existing IIIF Manifest.</Text>
                  </Flex>
                </button>
              </Card>
              <Card variant="surface">
                <Flex justify="between" align="center">
                  <Flex direction="column" gap="1">
                    <Text weight="medium" color="gray">Upload Works</Text>
                    <Text size="2" color="gray">Upload your own image files.</Text>
                  </Flex>
                  <Badge color="gray">Coming soon</Badge>
                </Flex>
              </Card>
              <Card asChild variant="surface" className="add-work-option">
                <button type="button" onClick={() => onSelectStep("create")}>
                  <Flex direction="column" gap="1">
                    <Text weight="medium">Create Work</Text>
                    <Text size="2" color="gray">Manually create a new, empty work.</Text>
                  </Flex>
                </button>
              </Card>
              <Flex justify="end" mt="2">
                <Button type="button" variant="soft" color="gray" onClick={onClose}>
                  Cancel
                </Button>
              </Flex>
            </Flex>
          </>
        )}

        {step === "create" && (
          <>
            <Dialog.Title>Create Work</Dialog.Title>
            <form onSubmit={onCreateSubmit}>
              <Flex direction="column" gap="3">
                <label>
                  <Text as="div" size="2" weight="medium" mb="1">Title</Text>
                  <TextField.Root
                    name="label"
                    type="text"
                    required
                    value={createForm.label}
                    onChange={handleCreateChange}
                    placeholder="e.g. 1973 yearbook"
                  />
                </label>
                {createError && (
                  <Callout.Root color="red" size="1">
                    <Callout.Text>{createError}</Callout.Text>
                  </Callout.Root>
                )}
                <Flex justify="between" gap="3" mt="2">
                  <Button type="button" variant="ghost" onClick={onBack} disabled={createSubmitting}>
                    ← Back
                  </Button>
                  <Flex gap="3">
                    <Button type="button" variant="soft" color="gray" onClick={onClose} disabled={createSubmitting}>
                      Cancel
                    </Button>
                    <Button type="submit" loading={createSubmitting}>
                      Create
                    </Button>
                  </Flex>
                </Flex>
              </Flex>
            </form>
          </>
        )}

        {step === "import-url" && (
          <>
            <Dialog.Title>Import Work</Dialog.Title>
            <form onSubmit={onImportFetch}>
              <Flex direction="column" gap="3">
                <label>
                  <Text as="div" size="2" weight="medium" mb="1">Manifest URL</Text>
                  <TextField.Root
                    type="url"
                    required
                    value={importUrl}
                    onChange={(evt) => onImportUrlChange(evt.target.value)}
                    placeholder="https://example.org/iiif/manifest.json"
                  />
                </label>
                {importError && (
                  <Callout.Root color="red" size="1">
                    <Callout.Text>{importError}</Callout.Text>
                  </Callout.Root>
                )}
                <Flex justify="between" gap="3" mt="2">
                  <Button type="button" variant="ghost" onClick={onBack} disabled={importFetching}>
                    ← Back
                  </Button>
                  <Flex gap="3">
                    <Button type="button" variant="soft" color="gray" onClick={onClose} disabled={importFetching}>
                      Cancel
                    </Button>
                    <Button type="submit" loading={importFetching}>
                      Fetch
                    </Button>
                  </Flex>
                </Flex>
              </Flex>
            </form>
          </>
        )}

        {step === "import-preview" && (
          <>
            <Dialog.Title>Confirm Import</Dialog.Title>
            <Flex direction="column" gap="3">
              <Card variant="surface">
                <Flex gap="3" align="center">
                  <button
                    type="button"
                    className="import-preview-thumbnail"
                    onClick={() => {
                      // Clover mutates the manifest object it's given, so hand it a
                      // disposable clone — the original must stay intact for Import.
                      setImportViewerContent(structuredClone(importPreview.manifest));
                      setShowImportViewer(true);
                    }}
                    aria-label="Preview manifest"
                  >
                    {importPreview?.thumbnail ? (
                      <img
                        src={`${importPreview.thumbnail.replace(/\/$/, "")}/full/,128/0/default.jpg`}
                        alt=""
                        onError={(evt) => {
                          evt.currentTarget.style.display = "none";
                        }}
                      />
                    ) : (
                      <Text size="1" color="gray">Preview</Text>
                    )}
                    <span className="import-preview-thumbnail__zoom">
                      <ZoomInIcon />
                    </span>
                  </button>
                  <Flex direction="column" gap="1" style={{flex: 1, minWidth: 0}}>
                    <Text weight="medium">{importPreview?.label || "(untitled)"}</Text>
                    <Text size="2" color="gray">
                      {importPreview?.itemCount ?? 0} canvas{importPreview?.itemCount === 1 ? "" : "es"}
                    </Text>
                    <Text size="1" color="gray" style={{wordBreak: "break-all"}}>
                      {importPreview?.sourceUrl}
                    </Text>
                  </Flex>
                </Flex>
              </Card>
              {importError && (
                <Callout.Root color="red" size="1">
                  <Callout.Text>{importError}</Callout.Text>
                </Callout.Root>
              )}
              <Flex justify="between" gap="3" mt="2">
                <Button type="button" variant="ghost" onClick={onBack} disabled={importConfirming}>
                  ← Back
                </Button>
                <Flex gap="3">
                  <Button type="button" variant="soft" color="gray" onClick={onClose} disabled={importConfirming}>
                    Cancel
                  </Button>
                  <Button type="button" onClick={onImportConfirm} loading={importConfirming}>
                    Import
                  </Button>
                </Flex>
              </Flex>
            </Flex>
            <Dialog.Root open={showImportViewer} onOpenChange={setShowImportViewer}>
              <Dialog.Content maxWidth="800px">
                <Flex justify="between" align="center" mb="2">
                  <Dialog.Title mb="0">{importPreview?.label || "Preview"}</Dialog.Title>
                  <Button type="button" variant="ghost" onClick={() => setShowImportViewer(false)}>
                    ← Back
                  </Button>
                </Flex>
                {importViewerContent && (
                  <Box className="viewer-stage" style={{width: "100%"}}>
                    <CloverViewer
                      key={importPreview?.sourceUrl}
                      iiifContent={importViewerContent}
                      customTheme={CLOVER_THEME}
                      options={CLOVER_OPTIONS}
                    />
                  </Box>
                )}
              </Dialog.Content>
            </Dialog.Root>
          </>
        )}
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
  onDeleteManifest,
}) {
  const searchApiAvailable = Boolean(SEARCH_API_BASE);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexResult, setReindexResult] = useState(null);
  const [reindexError, setReindexError] = useState(null);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query || !searchApiAvailable) {
      setSearchResults(null);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    setSearchError(null);
    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch(searchApiUrl(query), {errorMessage: "Search failed"});
        if (cancelled) return;
        setSearchResults(Array.isArray(data.hits) ? data.hits : []);
      } catch (err) {
        if (!cancelled) setSearchError(err.message);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, searchApiAvailable]);

  const handleReindex = async () => {
    if (!searchApiAvailable) return;
    setReindexing(true);
    setReindexError(null);
    setReindexResult(null);
    try {
      const data = await apiFetch(`${SEARCH_API_BASE}/reindex`, {
        method: "POST",
        errorMessage: "Unable to publish search index",
      });
      setReindexResult(data);
    } catch (err) {
      setReindexError(err.message);
    } finally {
      setReindexing(false);
    }
  };

  const isSearching = searchQuery.trim().length > 0;

  return (
    <Flex direction="column" gap="5">
      <Card size="3" className="panel manifest-panel">
        <Flex justify="between" align="center" gap="3" mb="4">
          <TextField.Root
            size="3"
            placeholder="Search works…"
            style={{flex: 1}}
            value={searchQuery}
            onChange={(evt) => setSearchQuery(evt.target.value)}
          />
          <Button
            type="button"
            size="3"
            variant="soft"
            onClick={handleReindex}
            disabled={!searchApiAvailable || reindexing}
            loading={reindexing}
          >
            Publish search index
          </Button>
          <Button
            type="button"
            size="3"
            onClick={onOpenManifestModal}
            disabled={!manifestApiAvailable}
          >
            <PlusIcon /> Add
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
          {reindexError && (
            <Callout.Root color="red" size="1" mb="3">
              <Callout.Text>{reindexError}</Callout.Text>
            </Callout.Root>
          )}
          {reindexResult && !reindexError && (
            <Callout.Root color="green" size="1" mb="3">
              <Callout.Text>
                Indexed {reindexResult.indexed ?? 0}, removed {reindexResult.deleted ?? 0} stale document
                {reindexResult.deleted === 1 ? "" : "s"}.
              </Callout.Text>
            </Callout.Root>
          )}
          {isSearching ? (
            <SearchResultsList results={searchResults} loading={searchLoading} error={searchError} />
          ) : manifestLoading ? (
            <Text as="p" size="2" color="gray">Loading works…</Text>
          ) : (
            <ManifestList
              manifests={manifests}
              selectedId={selectedManifestId}
              onDelete={onDeleteManifest}
            />
          )}
        </Box>
      </Card>
    </Flex>
  );
}

const IMPORT_STALE_MS = 6 * 60 * 1000;

function WorkDetailPanel({
  manifestDetail,
  manifestDetailLoading,
  manifestDetailError,
  importStatus,
  onResumeImport,
  onAttachAssets,
  canAddCanvas,
  importStale,
  onReorderCanvas,
  onRemoveCanvas,
  canvasSaving,
  canvasActionError,
  disableAddReason,
}) {
  const isFailed = importStatus?.status === "failed";
  const isStale = importStatus?.status === "in-progress" && importStale;
  const importInProgress = importStatus?.status === "in-progress" && !isStale;
  const [resumeError, setResumeError] = useState(null);

  // Clover mutates the manifest object it's given, and this one is the same
  // object the canvas reorder/remove handlers read from and write back to S3.
  const manifestObject = manifestDetail?.manifest ?? null;
  const viewerContent = useMemo(
    () => (manifestObject ? structuredClone(manifestObject) : null),
    [manifestObject],
  );

  const handleResumeClick = () => {
    setResumeError(null);
    Promise.resolve(onResumeImport(manifestDetail.identifier)).catch((err) =>
      setResumeError(err.message),
    );
  };

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
      {(isFailed || isStale) && (
        <Callout.Root color={isFailed ? "red" : "orange"} size="1">
          <Callout.Text>
            {isFailed
              ? `Image import failed${importStatus.error ? `: ${importStatus.error}` : ""}.`
              : "Image import hasn't made progress in a while — it may have stalled."}
            {" "}
            <Button variant="ghost" size="1" onClick={handleResumeClick}>
              Resume
            </Button>
            {resumeError ? ` — ${resumeError}` : ""}
          </Callout.Text>
        </Callout.Root>
      )}
      {importInProgress && (
        <Flex direction="column" gap="1">
          <Text size="2" color="gray">
            Importing image {Math.min((importStatus.currentIndex ?? 0) + 1, importStatus.total)} of{" "}
            {importStatus.total}
            {importStatus.phase ? ` — ${importStatus.phase}` : ""}
          </Text>
          <Progress value={importStatus.completed} max={importStatus.total || 1} />
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
                iiifContent={viewerContent}
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
            onAttachAssets={onAttachAssets}
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
  const [importStatus, setImportStatus] = useState(null);
  const [importStale, setImportStale] = useState(false);
  const [importPollGeneration, setImportPollGeneration] = useState(0);
  const [isManifestModalOpen, setManifestModalOpen] = useState(false);
  const [manifestModalStep, setManifestModalStep] = useState("choose");
  const [manifestForm, setManifestForm] = useState({label: ""});
  const [manifestFormError, setManifestFormError] = useState(null);
  const [manifestFormSubmitting, setManifestFormSubmitting] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importPreview, setImportPreview] = useState(null);
  const [importError, setImportError] = useState(null);
  const [importFetching, setImportFetching] = useState(false);
  const [importConfirming, setImportConfirming] = useState(false);
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
      const data = await apiFetch(endpoint, {errorMessage: "Unable to load works"});
      setManifests(Array.isArray(data.manifests) ? data.manifests : []);
    } catch (err) {
      setManifests([]);
      setManifestError(err.message);
    } finally {
      setManifestLoading(false);
    }
  }, [manifestApiAvailable, manifestApiUrl]);

  const handleDeleteManifest = useCallback(
    async (identifier) => {
      const endpoint = manifestApiUrl(encodeURIComponent(identifier));
      if (!endpoint) {
        throw new Error("Work API unavailable");
      }
      await apiFetch(endpoint, {method: "DELETE", errorMessage: "Unable to delete work"});
      await refreshManifests();
    },
    [manifestApiUrl, refreshManifests],
  );

  const handleResumeImport = useCallback(
    async (identifier) => {
      const endpoint = manifestApiUrl(`${encodeURIComponent(identifier)}/import-resume`);
      if (!endpoint) {
        throw new Error("Work API unavailable");
      }
      const data = await apiFetch(endpoint, {method: "POST", errorMessage: "Unable to resume import"});
      setImportStatus(data);
      setImportPollGeneration((g) => g + 1); // restart polling if it had stopped (e.g. after a failure)
    },
    [manifestApiUrl],
  );

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
      const data = await apiFetch(endpoint, {errorMessage: "Unable to load work"});
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
    setManifestForm((prev) => ({...prev, [name]: value}));
  }, []);

  const handleOpenManifestModal = () => {
    if (!manifestApiAvailable) return;
    setManifestModalStep("choose");
    setManifestForm({label: ""});
    setManifestFormError(null);
    setImportUrl("");
    setImportPreview(null);
    setImportError(null);
    setManifestModalOpen(true);
  };

  const handleCloseManifestModal = () => {
    setManifestModalOpen(false);
    setManifestFormError(null);
    setImportError(null);
  };

  const handleModalBack = () => {
    if (manifestModalStep === "import-preview") {
      setImportPreview(null);
      setImportError(null);
      setManifestModalStep("import-url");
    } else {
      setManifestModalStep("choose");
    }
  };

  const handleManifestSubmit = async (event) => {
    event.preventDefault();
    const label = manifestForm.label.trim();
    if (!label) {
      setManifestFormError("A title is required");
      return;
    }
    setManifestFormSubmitting(true);
    setManifestFormError(null);
    try {
      const endpoint = manifestApiUrl();
      if (!endpoint) {
        throw new Error("Work API unavailable");
      }
      const data = await apiFetch(endpoint, {
        method: "POST",
        body: {label},
        errorMessage: "Unable to create work",
      });
      await refreshManifests();
      selectWork(data.manifest?.identifier);
      setManifestModalOpen(false);
    } catch (err) {
      setManifestFormError(err.message);
    } finally {
      setManifestFormSubmitting(false);
    }
  };

  const handleImportFetch = async (event) => {
    event.preventDefault();
    const sourceUrl = importUrl.trim();
    if (!sourceUrl) {
      setImportError("A manifest URL is required");
      return;
    }
    setImportFetching(true);
    setImportError(null);
    try {
      const endpoint = manifestApiUrl("import/preview");
      if (!endpoint) {
        throw new Error("Work API unavailable");
      }
      const data = await apiFetch(endpoint, {
        method: "POST",
        body: {sourceUrl},
        errorMessage: "Unable to fetch that manifest",
      });
      setImportPreview(data);
      setManifestModalStep("import-preview");
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportFetching(false);
    }
  };

  const handleImportConfirm = async () => {
    if (!importPreview) return;
    setImportConfirming(true);
    setImportError(null);
    try {
      const endpoint = manifestApiUrl("import");
      if (!endpoint) {
        throw new Error("Work API unavailable");
      }
      const data = await apiFetch(endpoint, {
        method: "POST",
        body: {sourceUrl: importPreview.sourceUrl, manifest: importPreview.manifest},
        errorMessage: "Unable to import that manifest",
      });
      await refreshManifests();
      selectWork(data.manifest?.identifier);
      setManifestModalOpen(false);
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportConfirming(false);
    }
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
        const data = await apiFetch(endpoint, {
          method: "PUT",
          body: {items},
          errorMessage: "Unable to save assets",
        });
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

  const handleAttachAssets = useCallback(
    async (newCanvases) => {
      if (!manifestDetail?.manifest) {
        throw new Error("Select a work first");
      }
      const nextItems = [...(manifestDetail.manifest.items || []), ...newCanvases];
      await persistManifestItems(nextItems);
    },
    [manifestDetail, persistManifestItems],
  );

  const handleReorderCanvas = useCallback(
    async (index, delta) => {
      if (!manifestDetail?.manifest?.items) return;
      const items = [...manifestDetail.manifest.items];
      const targetIndex = index + delta;
      if (targetIndex < 0 || targetIndex >= items.length) return;
      [items[index], items[targetIndex]] = [items[targetIndex], items[index]];
      try {
        await persistManifestItems(items);
      } catch {
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
      } catch {
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

  useEffect(() => {
    if (!selectedManifestId || !manifestApiAvailable) {
      setImportStatus(null);
      setImportStale(false);
      return;
    }
    let cancelled = false;
    let intervalId = null;
    let previousStatus = null;

    const poll = async () => {
      const endpoint = manifestApiUrl(`${encodeURIComponent(selectedManifestId)}/import-status`);
      if (!endpoint) return;
      try {
        // apiFetch throws on a non-2xx rather than letting an error body through
        // as if it were a status record; the catch below treats that as transient.
        const data = await apiFetch(endpoint, {errorMessage: "Unable to read import status"});
        if (cancelled || !data) return;
        if (previousStatus === "in-progress" && data.status === "complete") {
          fetchManifestDetail(selectedManifestId);
        }
        previousStatus = data.status;
        setImportStatus(data);
        setImportStale(
          data.status === "in-progress" &&
            Boolean(data.updatedAt) &&
            Date.now() - Date.parse(data.updatedAt) > IMPORT_STALE_MS,
        );
        if (data.status !== "in-progress" && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      } catch {
        // ignore transient polling errors
      }
    };

    poll();
    intervalId = setInterval(poll, 2000);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [selectedManifestId, manifestApiAvailable, manifestApiUrl, fetchManifestDetail, importPollGeneration]);

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
                importStatus={importStatus}
                importStale={importStale}
                onResumeImport={handleResumeImport}
                onAttachAssets={handleAttachAssets}
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
                onDeleteManifest={handleDeleteManifest}
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
      <AddWorkModal
        open={isManifestModalOpen}
        onClose={handleCloseManifestModal}
        step={manifestModalStep}
        onSelectStep={setManifestModalStep}
        onBack={handleModalBack}
        createForm={manifestForm}
        onCreateChange={handleManifestFieldChange}
        onCreateSubmit={handleManifestSubmit}
        createSubmitting={manifestFormSubmitting}
        createError={manifestFormError}
        importUrl={importUrl}
        onImportUrlChange={setImportUrl}
        onImportFetch={handleImportFetch}
        importFetching={importFetching}
        importError={importError}
        importPreview={importPreview}
        onImportConfirm={handleImportConfirm}
        importConfirming={importConfirming}
      />
    </main>
  );
}
