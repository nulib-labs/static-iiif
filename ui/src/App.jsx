import {useCallback, useEffect, useMemo, useState} from "react";
import {Link as RouterLink, useNavigate, useParams} from "react-router-dom";
import {Amplify} from "aws-amplify";
import {fetchAuthSession} from "aws-amplify/auth";
import AssetThumbnails from "./components/AssetThumbnails";
import AssetDropzone from "./components/AssetDropzone";
import {buildThumbnailUrlFromInfo} from "./lib/canvasAssets";
import CloverViewer from "@samvera/clover-iiif/viewer";
import {CLOVER_OPTIONS, CLOVER_THEME} from "./cloverTheme";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {CSS} from "@dnd-kit/utilities";
import {
  ArrowUpIcon,
  PlusIcon,
  CheckIcon,
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
  TextArea,
  Select,
  Dialog,
  AlertDialog,
  DropdownMenu,
  Callout,
  Badge,
  Progress,
  SegmentedControl,
} from "@radix-ui/themes";
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
      <Table.Root variant="ghost" className="manifest-list">
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

// Click the text to edit it in place; Check (or Enter) saves and reverts to plain
// text, Escape cancels. Used for canvas labels and every manifest metadata field.
//   multiline  — a TextArea, where Enter inserts a newline and only Check saves.
//   allowEmpty — permit clearing the value (a description can be removed; a
//                canvas label cannot, so it keeps the default guard).
function InlineTextEditor({
  value: savedValue,
  onSave,
  multiline = false,
  allowEmpty = false,
  placeholder = "Not set",
  as = "p",
  textProps = {weight: "bold", size: "2"},
  fieldSize = "1",
  ariaLabel = "Edit value",
  className = "",
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(savedValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!editing) setDraft(savedValue);
  }, [savedValue, editing]);

  const startEditing = () => {
    setError(null);
    setDraft(savedValue);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setDraft(savedValue);
    setError(null);
  };

  const handleSave = async () => {
    const trimmed = draft.trim();
    if ((!trimmed && !allowEmpty) || trimmed === savedValue) {
      cancelEditing();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <Text
        as={as}
        {...textProps}
        color={savedValue ? textProps.color : "gray"}
        role="button"
        tabIndex={0}
        className={`canvas-label-editable ${className}`.trim()}
        onClick={startEditing}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            startEditing();
          }
        }}
      >
        {savedValue || placeholder}
      </Text>
    );
  }

  const onKeyDown = (event) => {
    // In a TextArea Enter has to stay a newline, so Check is the only way to save.
    if (event.key === "Enter" && !multiline) handleSave();
    if (event.key === "Escape") cancelEditing();
  };

  return (
    <Flex direction="column" gap="1">
      <Flex align={multiline ? "end" : "center"} gap="1">
        {multiline ? (
          <TextArea
            size={fieldSize}
            value={draft}
            autoFocus
            disabled={saving}
            rows={3}
            style={{flex: 1}}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        ) : (
          <TextField.Root
            size={fieldSize}
            value={draft}
            style={{flex: 1}}
            autoFocus
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
        <IconButton size={fieldSize} variant="soft" onClick={handleSave} loading={saving} aria-label={ariaLabel}>
          <CheckIcon />
        </IconButton>
      </Flex>
      {error && <Text as="p" size="1" color="red">{error}</Text>}
    </Flex>
  );
}

// Radix's DragHandleDots icons are 2 columns wide; this is a 3x3 grid.
function DragHandleGridIcon({size = 18}) {
  const positions = [3, 8, 13];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {positions.flatMap((cx) =>
        positions.map((cy) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.4" />),
      )}
    </svg>
  );
}

// One canvas row. Imported canvases are draggable and removable; canvases the
// import chain has not reached yet show their own progress instead — reordering
// mid-import would desync the chain, which walks canvases by index.
function SortableCanvasCard({
  id,
  canvas,
  index,
  disabled,
  importState,
  importPhase,
  onRenameCanvas,
  onRemoveCanvas,
}) {
  const isImported = importState === "done";
  const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({
    id,
    disabled: disabled || !isImported,
  });

  const style = {
    // Zero out x so a dragged card tracks the pointer vertically only — cheaper
    // than pulling in @dnd-kit/modifiers just for restrictToVerticalAxis.
    transform: CSS.Transform.toString(transform ? {...transform, x: 0} : null),
    transition,
  };

  const serviceId = canvas.items?.[0]?.items?.[0]?.body?.service?.[0]?.id;
  const thumbnailUrl = serviceId ? buildThumbnailUrlFromInfo({id: serviceId}) : null;

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={[
        "canvas-list-item",
        isDragging ? "canvas-list-item--dragging" : "",
        isImported ? "" : "canvas-list-item--importing",
      ].filter(Boolean).join(" ")}
    >
      <Flex justify="between" align="center" gap="3">
        <Flex align="center" gap="3" className="canvas-list-info">
          {isImported ? (
            <button
              type="button"
              className="canvas-drag-handle"
              aria-label="Reorder asset"
              {...attributes}
              {...listeners}
            >
              <DragHandleGridIcon />
            </button>
          ) : (
            <span className="canvas-drag-handle canvas-drag-handle--inert" aria-hidden="true">
              <DragHandleGridIcon />
            </span>
          )}
          {thumbnailUrl ? (
            <img src={thumbnailUrl} alt="" className="asset-dropzone-preview" />
          ) : null}
          {isImported ? (
            <InlineTextEditor
              value={canvas.label?.none?.[0] || `Asset ${index + 1}`}
              onSave={(value) => onRenameCanvas(index, value)}
              ariaLabel="Save label"
              textProps={{weight: "bold", size: "3"}}
              fieldSize="2"
            />
          ) : (
            <Flex direction="column" gap="1" className="canvas-import-progress">
              <Text as="p" size="3" weight="bold" color="gray">
                {canvas.label?.none?.[0] || `Asset ${index + 1}`}
              </Text>
              <Text as="p" size="1" color="gray">
                {importState === "active" ? importPhase || "Importing…" : "Waiting to import…"}
              </Text>
              {/* Indeterminate while this canvas is the one being worked on. */}
              <Progress size="1" duration={importState === "active" ? "60s" : undefined}
                        value={importState === "active" ? undefined : 0}
                        max={100} />
            </Flex>
          )}
        </Flex>
        <Flex gap="2" className="canvas-list-actions">
          <Tooltip content="Remove asset">
            <IconButton
              type="button"
              variant="soft"
              color="red"
              size="1"
              onClick={() => onRemoveCanvas(index)}
              disabled={disabled || !isImported}
              aria-label="Remove asset"
            >
              <TrashIcon />
            </IconButton>
          </Tooltip>
        </Flex>
      </Flex>
    </Card>
  );
}

// The four IIIF layout behaviors. The spec defines these as disjoint — exactly
// one applies — so a single-select is the right control, not a multi-select.
const LAYOUT_BEHAVIORS = [
  {value: "individuals", label: "Individuals — one canvas at a time"},
  {value: "paged", label: "Paged — book-style two-page spreads"},
  {value: "continuous", label: "Continuous — canvases joined end to end"},
  {value: "unordered", label: "Unordered — no inherent sequence"},
];
const BEHAVIOR_UNSET = "__unset__";

// IIIF language maps are {"none": ["a", "b"]}. Imported manifests routinely lack
// `summary` and `behavior` entirely, so every read here tolerates undefined.
function readLanguageMap(map) {
  const values = map && typeof map === "object" ? Object.values(map)[0] : null;
  return Array.isArray(values) ? values : [];
}

function toLanguageMap(values) {
  return {none: values};
}

function ManifestMetadataPanel({manifest, onSaveSummary, onSaveMetadata}) {
  const entries = Array.isArray(manifest?.metadata) ? manifest.metadata : [];
  const summary = readLanguageMap(manifest?.summary)[0] || "";

  // Every row mutation rebuilds and saves the whole metadata array — the API
  // takes the field wholesale.
  const saveEntries = (next) => onSaveMetadata(next.length ? next : null);

  const updateEntry = (index, mutate) =>
    saveEntries(entries.map((entry, i) => (i === index ? mutate(entry) : entry)));

  return (
    <Flex direction="column" gap="5" className="metadata-panel">
      <Flex direction="column" className="metadata-fields">
        <Box>
          <Text as="p" size="2" color="gray" mb="1">Description</Text>
          <InlineTextEditor
            value={summary}
            onSave={(value) => onSaveSummary(value ? toLanguageMap([value]) : null)}
            multiline
            allowEmpty
            ariaLabel="Save description"
            placeholder="No description"
            textProps={{size: "3"}}
            fieldSize="2"
          />
        </Box>

        <Box>
          <Text as="p" size="2" color="gray" mb="2">Additional fields</Text>
          {entries.length === 0 ? (
            <Text as="p" size="3" color="gray">No additional fields.</Text>
          ) : (
            <Table.Root variant="ghost" size="2" className="metadata-table">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Field</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Values</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {entries.map((entry, index) => {
                  const values = readLanguageMap(entry.value);
                  return (
                    <Table.Row key={index}>
                      <Table.RowHeaderCell>
                        <InlineTextEditor
                          value={readLanguageMap(entry.label)[0] || ""}
                          onSave={(value) =>
                            updateEntry(index, (e) => ({...e, label: toLanguageMap([value])}))
                          }
                          ariaLabel="Save field name"
                          placeholder="Field name"
                          textProps={{weight: "bold", size: "3"}}
                          fieldSize="2"
                        />
                      </Table.RowHeaderCell>
                      <Table.Cell>
                        <Flex direction="column" gap="2">
                          {values.map((value, valueIndex) => (
                            <Flex key={valueIndex} align="center" gap="2">
                              <Box style={{flex: 1, minWidth: 0}}>
                                <InlineTextEditor
                                  value={value}
                                  onSave={(next) =>
                                    updateEntry(index, (e) => ({
                                      ...e,
                                      value: toLanguageMap(
                                        values.map((v, i) => (i === valueIndex ? next : v)),
                                      ),
                                    }))
                                  }
                                  ariaLabel="Save value"
                                  textProps={{size: "3"}}
                                  fieldSize="2"
                                />
                              </Box>
                              <Tooltip content="Remove value">
                                <IconButton
                                  type="button"
                                  variant="soft"
                                  color="red"
                                  size="1"
                                  aria-label="Remove value"
                                  disabled={values.length <= 1}
                                  onClick={() =>
                                    updateEntry(index, (e) => ({
                                      ...e,
                                      value: toLanguageMap(values.filter((_, i) => i !== valueIndex)),
                                    }))
                                  }
                                >
                                  <TrashIcon />
                                </IconButton>
                              </Tooltip>
                            </Flex>
                          ))}
                          <Box>
                            <Button
                              type="button"
                              variant="ghost"
                              size="2"
                              onClick={() =>
                                updateEntry(index, (e) => ({
                                  ...e,
                                  value: toLanguageMap([...values, "New value"]),
                                }))
                              }
                            >
                              <PlusIcon /> Add value
                            </Button>
                          </Box>
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>
                        <Tooltip content="Remove field">
                          <IconButton
                            type="button"
                            variant="soft"
                            color="red"
                            size="1"
                            aria-label="Remove field"
                            onClick={() => saveEntries(entries.filter((_, i) => i !== index))}
                          >
                            <TrashIcon />
                          </IconButton>
                        </Tooltip>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          )}
          <Box mt="2">
            <Button
              type="button"
              variant="soft"
              size="2"
              onClick={() =>
                saveEntries([
                  ...entries,
                  {label: toLanguageMap(["New field"]), value: toLanguageMap(["New value"])},
                ])
              }
            >
              <PlusIcon /> Add field
            </Button>
          </Box>
        </Box>
      </Flex>
    </Flex>
  );
}

function ManifestLayoutPanel({manifest, onSaveBehavior}) {
  const behavior = Array.isArray(manifest?.behavior) ? manifest.behavior[0] : null;
  return (
    <Flex direction="column" className="metadata-panel metadata-fields">
      <Box>
        <Text as="p" size="2" color="gray" mb="1">Display</Text>
        <Select.Root
          value={behavior || BEHAVIOR_UNSET}
          onValueChange={(value) => onSaveBehavior(value === BEHAVIOR_UNSET ? null : [value])}
        >
          <Select.Trigger placeholder="Not set" size="2" />
          <Select.Content>
            <Select.Item value={BEHAVIOR_UNSET}>Not set</Select.Item>
            {LAYOUT_BEHAVIORS.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </Box>
    </Flex>
  );
}

function ManifestDetail({
  detail,
  loading,
  error,
  onAttachAssets,
  canAddCanvas,
  onMoveCanvas,
  onRemoveCanvas,
  onRenameCanvas,
  importStatus,
  canvasSaving,
  canvasActionError,
  disableAddReason,
}) {
  const sensors = useSensors(
    // A small threshold keeps a click on the handle a click, and stops clicks on
    // the label editor from being swallowed as drags.
    useSensor(PointerSensor, {activationConstraint: {distance: 5}}),
    useSensor(KeyboardSensor, {coordinateGetter: sortableKeyboardCoordinates}),
  );

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
  const canvasIds = canvases.map((canvas, index) => canvas.id || `canvas-${index}`);

  // The import chain walks canvases in order, so `completed` is the boundary
  // between what has been copied locally and what has not. No active import
  // means everything is already local.
  const canvasImportState = (index) => {
    if (!importStatus) return "done";
    const completed = importStatus.completed ?? 0;
    if (index < completed) return "done";
    if (index === (importStatus.currentIndex ?? completed)) return "active";
    return "pending";
  };

  const handleDragEnd = ({active, over}) => {
    if (!over || active.id === over.id) return;
    const from = canvasIds.indexOf(active.id);
    const to = canvasIds.indexOf(over.id);
    if (from === -1 || to === -1) return;
    onMoveCanvas(from, to);
  };

  return (
    <Box className="manifest-detail">
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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={canvasIds} strategy={verticalListSortingStrategy}>
              <Flex direction="column" gap="2" className="canvas-list">
                {canvases.map((canvas, index) => (
                  <SortableCanvasCard
                    key={canvasIds[index]}
                    id={canvasIds[index]}
                    canvas={canvas}
                    index={index}
                    disabled={canvasSaving}
                    importState={canvasImportState(index)}
                    importPhase={importStatus?.phase}
                    onRenameCanvas={onRenameCanvas}
                    onRemoveCanvas={onRemoveCanvas}
                  />
                ))}
              </Flex>
            </SortableContext>
          </DndContext>
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
  viewerRevision,
  importStatus,
  onResumeImport,
  onAttachAssets,
  canAddCanvas,
  importStale,
  onMoveCanvas,
  onRemoveCanvas,
  onRenameCanvas,
  onSaveTitle,
  onSaveSummary,
  onSaveMetadata,
  onSaveBehavior,
  canvasSaving,
  canvasActionError,
  disableAddReason,
}) {
  const isFailed = importStatus?.status === "failed";
  const isStale = importStatus?.status === "in-progress" && importStale;
  const importInProgress = importStatus?.status === "in-progress" && !isStale;
  const [resumeError, setResumeError] = useState(null);
  const [section, setSection] = useState("assets");
  const [sharedNotice, setSharedNotice] = useState(null);

  // Copy rather than open: "Share" is about handing the URL to someone else, and
  // the raw manifest is already one click away in the viewer's About panel.
  const handleShareManifest = async () => {
    const url = manifestDetail?.manifestUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setSharedNotice("Copied!");
    } catch {
      // Clipboard access can be blocked; fall back to opening the manifest.
      window.open(url, "_blank", "noopener");
      setSharedNotice("Opened");
    }
    setTimeout(() => setSharedNotice(null), 1500);
  };

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
        <Flex direction="column" align="center" gap="7" pt="8">
          <Button asChild size="3">
            <RouterLink to="/works">
              <ArrowUpIcon /> View all Works
            </RouterLink>
          </Button>
          {/* The work title is edited here rather than in the Metadata tab —
              it is the page's own heading. Its size lives in CSS because the
              requested 2x of the old size-6 falls between Radix's steps. */}
          <InlineTextEditor
            as="h1"
            value={manifestDetail.label || ""}
            onSave={onSaveTitle}
            placeholder={manifestDetail.identifier}
            ariaLabel="Save title"
            textProps={{weight: "bold"}}
            fieldSize="3"
            className="work-title-editable"
          />
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
                key={`${manifestDetail.identifier}::${viewerRevision}`}
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
      {/* Sits in the gap between the viewer and the panel below it. */}
      <Flex justify="between" align="center" gap="3" mt="6">
        <SegmentedControl.Root size="3" value={section} onValueChange={setSection}>
          <SegmentedControl.Item value="assets">Assets</SegmentedControl.Item>
          <SegmentedControl.Item value="metadata">Metadata</SegmentedControl.Item>
          <SegmentedControl.Item value="layout">Layout</SegmentedControl.Item>
        </SegmentedControl.Root>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger disabled={!manifestDetail}>
            {/* Content caps at size 2, but the trigger matches the segmented control. */}
            <Button size="3">
              Share
              <DropdownMenu.TriggerIcon />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content size="2">
            <DropdownMenu.Item onSelect={handleShareManifest}>
              {sharedNotice || "IIIF Manifest"}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </Flex>
      <Card size="3" className="panel manifest-panel">
        <Box className="panel-body manifest-panel-body">
          {section === "assets" ? (
            <ManifestDetail
              detail={manifestDetail}
              loading={manifestDetailLoading}
              error={manifestDetailError}
              onAttachAssets={onAttachAssets}
              canAddCanvas={canAddCanvas}
              onMoveCanvas={onMoveCanvas}
              onRemoveCanvas={onRemoveCanvas}
              onRenameCanvas={onRenameCanvas}
              importStatus={importInProgress ? importStatus : null}
              canvasSaving={canvasSaving}
              canvasActionError={canvasActionError}
              disableAddReason={disableAddReason}
            />
          ) : !manifestDetail ? (
            <Text as="p" color="gray" className="manifest-detail-placeholder">
              Select a work to edit it.
            </Text>
          ) : section === "metadata" ? (
            <ManifestMetadataPanel
              manifest={manifestDetail.manifest}
              onSaveSummary={onSaveSummary}
              onSaveMetadata={onSaveMetadata}
            />
          ) : (
            <ManifestLayoutPanel
              manifest={manifestDetail.manifest}
              onSaveBehavior={onSaveBehavior}
            />
          )}
        </Box>
      </Card>
    </Flex>
  );
}

export default function App({ signOut }) {
  const {workId} = useParams();
  const navigate = useNavigate();
  const selectedManifestId = workId ? decodeURIComponent(workId) : null;

  const selectWork = useCallback(
    (identifier) => {
      navigate(identifier ? `/works/${encodeURIComponent(identifier)}` : "/works");
    },
    [navigate],
  );

  const manifestApiAvailable = Boolean(MANIFEST_API_BASE);
  const [manifests, setManifests] = useState([]);
  const [manifestLoading, setManifestLoading] = useState(manifestApiAvailable);
  const [manifestError, setManifestError] = useState(null);
  const [manifestDetail, setManifestDetail] = useState(null);
  const [manifestDetailLoading, setManifestDetailLoading] = useState(false);
  const [manifestDetailError, setManifestDetailError] = useState(null);
  // Clover parses a manifest into a vault built once per mount, and never re-reads
  // an id it has already normalized — so a save only reaches the viewer if we
  // remount it. Bumped whenever a manifest lands from the server; it feeds the
  // viewer's React key.
  const [viewerRevision, setViewerRevision] = useState(0);
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
      setViewerRevision((revision) => revision + 1);
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
        setViewerRevision((revision) => revision + 1);
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

  // Manifest-level fields (label/summary/metadata/behavior) go through their own
  // route; PUT .../items writes only `items`.
  const persistManifestFields = useCallback(
    async (fields) => {
      if (!selectedManifestId) {
        throw new Error("Select a work first");
      }
      const endpoint = manifestApiUrl(encodeURIComponent(selectedManifestId));
      const data = await apiFetch(endpoint, {
        method: "PUT",
        body: fields,
        errorMessage: "Unable to save metadata",
      });
      setManifestDetail(data.manifest);
      // `label` retitles the viewer and `behavior: paged` re-lays it out, so the
      // viewer has to reload the same way an items save makes it reload.
      setViewerRevision((revision) => revision + 1);
      setManifests((prev) =>
        prev.map((manifest) =>
          manifest.identifier === selectedManifestId
            ? {...manifest, label: data.manifest.label}
            : manifest,
        ),
      );
      return data.manifest;
    },
    [manifestApiUrl, selectedManifestId],
  );

  const handleSaveTitle = useCallback(
    (value) => persistManifestFields({label: {none: [value]}}),
    [persistManifestFields],
  );
  const handleSaveSummary = useCallback(
    (summary) => persistManifestFields({summary}),
    [persistManifestFields],
  );
  const handleSaveMetadata = useCallback(
    (metadata) => persistManifestFields({metadata}),
    [persistManifestFields],
  );
  const handleSaveBehavior = useCallback(
    (behavior) => persistManifestFields({behavior}),
    [persistManifestFields],
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

  const handleMoveCanvas = useCallback(
    async (fromIndex, toIndex) => {
      const current = manifestDetail?.manifest?.items;
      if (!current) return;
      const nextItems = arrayMove(current, fromIndex, toIndex);
      // Show the new order at once; the PUT below only confirms it. Without this
      // the dropped card snaps back for the whole round-trip, because
      // persistManifestItems sets state only after the server responds.
      setManifestDetail((prev) =>
        prev ? {...prev, manifest: {...prev.manifest, items: nextItems}} : prev,
      );
      try {
        await persistManifestItems(nextItems);
      } catch {
        // Roll back to the pre-drag order; the message surfaces via canvasActionError.
        setManifestDetail((prev) =>
          prev ? {...prev, manifest: {...prev.manifest, items: current}} : prev,
        );
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

  const handleRenameCanvas = useCallback(
    async (index, label) => {
      if (!manifestDetail?.manifest?.items) return;
      const trimmed = label.trim();
      if (!trimmed) return;
      const items = manifestDetail.manifest.items.map((canvas, idx) =>
        idx === index ? {...canvas, label: {none: [trimmed]}} : canvas,
      );
      await persistManifestItems(items);
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
    <>
      {/* Full-bleed purple utility bar, mirroring the one at the top of
          library.northwestern.edu. Its contents align to the same container
          width as the page below it. */}
      <header className="nu-header">
        <div className="nu-header-inner">
          <a className="nu-wordmark" href="https://www.northwestern.edu/">
            {/* The wordmark is a background image, so keep the name available to
                screen readers — same approach the Northwestern sites use. */}
            <span className="nu-wordmark-label">Northwestern</span>
          </a>
          {signOut && (
            <button type="button" className="nu-header-action" onClick={signOut}>
              Sign out
            </button>
          )}
        </div>
      </header>
      <main className="layout">
      <div className="layout-container">
        <Flex direction="column" gap="2" className="layout-header">
          <Heading as="h1" size="5">Static IIIF</Heading>
        </Flex>
        <Box pt="2">
          {selectedManifestId ? (
            <WorkDetailPanel
              manifestDetail={manifestDetail}
              manifestDetailLoading={manifestDetailLoading}
              manifestDetailError={manifestDetailError}
              viewerRevision={viewerRevision}
              importStatus={importStatus}
              importStale={importStale}
              onResumeImport={handleResumeImport}
              onAttachAssets={handleAttachAssets}
              canAddCanvas={canAddCanvas}
              onMoveCanvas={handleMoveCanvas}
              onRemoveCanvas={handleRemoveCanvas}
              onRenameCanvas={handleRenameCanvas}
              onSaveTitle={handleSaveTitle}
              onSaveSummary={handleSaveSummary}
              onSaveMetadata={handleSaveMetadata}
              onSaveBehavior={handleSaveBehavior}
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
        </Box>
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
      </div>
      </main>
    </>
  );
}
