import {useCallback, useEffect, useMemo, useState} from "react";
import {Link as RouterLink, useNavigate, useParams} from "react-router-dom";
import {Box, Button, Callout, Card, DropdownMenu, Flex, SegmentedControl, Text} from "@radix-ui/themes";
import {ArrowUpIcon} from "@radix-ui/react-icons";
import CloverViewer from "@samvera/clover-iiif/viewer";
import {arrayMove} from "@dnd-kit/sortable";
import {COLLECTION_API_BASE, MANIFEST_API_BASE, apiFetch, manifestApiUrl} from "../lib/api";
import {CLOVER_OPTIONS, CLOVER_THEME} from "../cloverTheme";
import PageHeading from "../components/PageHeading";
import InlineTextEditor from "../components/InlineTextEditor";
import CanvasList from "../components/work/CanvasList";
import MetadataPanel from "../components/work/MetadataPanel";
import LayoutPanel from "../components/work/LayoutPanel";
import LinkingPanel from "../components/work/LinkingPanel";

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
  workCollection,
  onMoveWork,
  canvasSaving,
  canvasActionError,
  disableAddReason,
  collectionPath,
  collectionLabel,
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
  // The API resolves this for us (managed partOf entries only), so the client
  // never re-parses partOf and the save response does not need to ship a whole
  // manifest back just to report membership. Memoized for the same reason
  // viewerContent is: a fresh array every render would make the field's
  // prop-resync effect fire every render and setState a never-equal value.

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
            <RouterLink to={collectionPath}>
              <ArrowUpIcon /> Back to {collectionLabel}
            </RouterLink>
          </Button>
          {/* The work title is edited here rather than in the Metadata tab —
              it is the page's own heading, and shares .page-heading with every
              section heading so the two treatments cannot drift. */}
          <InlineTextEditor
            as="h1"
            value={manifestDetail.label || ""}
            onSave={onSaveTitle}
            placeholder={manifestDetail.identifier}
            ariaLabel="Save title"
            textProps={{weight: "bold"}}
            fieldSize="3"
            className="page-heading work-title-editable"
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
          <SegmentedControl.Item value="linking">Linking</SegmentedControl.Item>
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
            <CanvasList
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
            <MetadataPanel
              manifest={manifestDetail.manifest}
              onSaveSummary={onSaveSummary}
              onSaveMetadata={onSaveMetadata}
            />
          ) : section === "linking" ? (
            <LinkingPanel collection={workCollection} onMove={onMoveWork} />
          ) : (
            <LayoutPanel
              manifest={manifestDetail.manifest}
              onSaveBehavior={onSaveBehavior}
            />
          )}
        </Box>
      </Card>
    </Flex>
  );
}

// The work route owns everything scoped to one work: its detail, its saves and
// its import poll. Splitting this out of App() is what removes the hand-patching
// of the works list after every save — the list lives on its own route now and
// refetches when you navigate back to it.
export default function WorkPage() {
  const {slug: rawSlug, workId} = useParams();
  const slug = rawSlug ? decodeURIComponent(rawSlug) : null;
  const selectedManifestId = workId ? decodeURIComponent(workId) : null;
  const collectionPath = `/collection/${encodeURIComponent(slug)}`;
  const navigate = useNavigate();

  const manifestApiAvailable = Boolean(MANIFEST_API_BASE);
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
  const [canvasSaving, setCanvasSaving] = useState(false);
  const [canvasActionError, setCanvasActionError] = useState(null);

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
    [],
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
    } catch (err) {
      setManifestDetail(null);
      setManifestDetailError(err.message);
    } finally {
      setManifestDetailLoading(false);
    }
  }, [manifestApiAvailable]);

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
        return data.manifest;
      } catch (err) {
        setCanvasActionError(err.message);
        throw err;
      } finally {
        setCanvasSaving(false);
      }
    },
    [selectedManifestId],
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
      return data.manifest;
    },
    [selectedManifestId],
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

  // Membership lives in `partOf`, which nothing in the viewer reads — so unlike
  // persistManifestFields this must NOT bump viewerRevision. Remounting Clover
  // here would throw away the user's zoom and page position to redraw a change
  // the viewer cannot even see.
  // Moving deliberately does NOT bump viewerRevision: membership lives in
  // partOf, which nothing in the viewer reads, and remounting Clover would
  // throw away the user's zoom and page position for a change it cannot see.
  const moveWork = useCallback(
    async (label) => {
      if (!selectedManifestId) {
        throw new Error("Select a work first");
      }
      const endpoint = manifestApiUrl(`${encodeURIComponent(selectedManifestId)}/collection`);
      const data = await apiFetch(endpoint, {
        method: "PUT",
        body: {collection: label},
        errorMessage: "Unable to move this work",
      });
      const next = data.work?.collection ?? null;
      setManifestDetail((prev) =>
        prev && prev.identifier === selectedManifestId ? {...prev, collection: next} : prev,
      );
      // The work now lives under a different slug, so the URL it was reached by
      // is stale. Replace rather than push: the old URL would 404 on Back.
      if (next?.slug && next.slug !== slug) {
        navigate(`/collection/${encodeURIComponent(next.slug)}/work/${encodeURIComponent(selectedManifestId)}`, {replace: true});
      }
      return next;
    },
    [selectedManifestId, slug, navigate],
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
  }, [selectedManifestId, manifestApiAvailable, fetchManifestDetail, importPollGeneration]);

  // The work reports its own collections, so a deep link needs no second
  // request to name the one it arrived under.
  const collectionLabel = useMemo(() => {
    const own = manifestDetail?.collection;
    return own?.slug === slug ? own.label : slug;
  }, [manifestDetail, slug]);

  const canAddCanvas = Boolean(manifestDetail) && manifestApiAvailable;
  const disableAddReason = (() => {
    if (!manifestDetail) return null;
    if (!manifestApiAvailable) {
      return "Work API unavailable.";
    }
    return null;
  })();

  return (
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
      workCollection={manifestDetail?.collection || null}
      onMoveWork={moveWork}
      canvasSaving={canvasSaving}
      canvasActionError={canvasActionError}
      disableAddReason={disableAddReason}
      collectionPath={collectionPath}
      collectionLabel={collectionLabel}
    />
  );
}
