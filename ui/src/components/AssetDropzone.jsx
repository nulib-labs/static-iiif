import {useCallback, useEffect, useRef, useState} from "react";
import {uploadData} from "aws-amplify/storage";
import {ImageIcon, TrashIcon, UploadIcon} from "@radix-ui/react-icons";
import {Box, Button, Callout, Flex, IconButton, Progress, Text, TextField} from "@radix-ui/themes";
import {assetLabelFromKey, buildCanvasResource, buildInfoUrlFromKey, buildThumbnailUrlFromInfo} from "../lib/canvasAssets";
import "./AssetDropzone.css";

const SOURCE_BUCKET = import.meta.env.VITE_SOURCE_BUCKET || "";
const STORAGE_REGION = import.meta.env.VITE_STORAGE_REGION || import.meta.env.VITE_AWS_REGION || "";

// Amplify's default configured Storage bucket (VITE_STORAGE_BUCKET) is the IIIF
// *output* bucket — uploads need to go to the separate *source* bucket instead
// (the one the iiif-image Lambda watches), so every uploadData call must target
// it explicitly rather than relying on the default.
const SOURCE_BUCKET_TARGET = {bucketName: SOURCE_BUCKET, region: STORAGE_REGION};

// A freshly uploaded file still needs the S3-triggered iiif-image Lambda to produce
// a pyramid TIFF before serverless-iiif can serve its info.json — poll for it as soon
// as the upload finishes (rather than waiting for "Add to work") so processing has a
// head start and the real, always-renderable IIIF thumbnail can replace the local preview.
const INFO_POLL_INTERVAL_MS = 1500;
const INFO_POLL_ATTEMPTS = 14; // ~20s of retrying

// Most browsers can't decode TIFF (the usual source format for this pipeline) via <img>,
// so the local blob preview silently fails to render for it — fall back to a generic icon
// rather than leaving a blank/broken image in its place. `key` on the call site remounts
// this (resetting `failed`) whenever the source swaps from the local blob to the real
// IIIF thumbnail once processing finishes.
function PendingPreview({src}) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return (
      <Box className="asset-dropzone-preview asset-dropzone-preview--fallback">
        <ImageIcon width="18" height="18" />
      </Box>
    );
  }
  return <img src={src} alt="" className="asset-dropzone-preview" onError={() => setFailed(true)} />;
}

function extensionFromFilename(name) {
  const match = /\.[^./]+$/.exec(name || "");
  return match ? match[0].toLowerCase() : "";
}

async function waitForImageInfo(key) {
  const infoUrl = buildInfoUrlFromKey(key);
  if (!infoUrl) {
    throw new Error("VITE_IIIF_BASE_URL is not configured");
  }
  for (let attempt = 0; attempt < INFO_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(infoUrl).catch(() => null);
    if (response?.ok) {
      return response.json();
    }
    await new Promise((resolve) => setTimeout(resolve, INFO_POLL_INTERVAL_MS));
  }
  throw new Error("Image is still processing — try again in a moment");
}

export default function AssetDropzone({workId, manifest, disabled, disabledReason, onAttach}) {
  const [pending, setPending] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState(null);
  const fileInputRef = useRef(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(
    () => () => {
      pendingRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    },
    [],
  );

  const updatePending = useCallback((tempId, patch) => {
    setPending((prev) =>
      prev.map((item) => (item.tempId === tempId ? {...item, ...patch} : item)),
    );
  }, []);

  const resolveImageInfo = useCallback(
    async (tempId, key) => {
      try {
        const info = await waitForImageInfo(key);
        updatePending(tempId, {status: "ready", imageInfo: info});
      } catch (err) {
        updatePending(tempId, {status: "error", errorMessage: err.message || "Unable to process image"});
      }
    },
    [updatePending],
  );

  const uploadFile = useCallback(
    async (tempId, file) => {
      const ext = extensionFromFilename(file.name);
      const key = `image/${workId}/${tempId}${ext}`;
      try {
        const task = uploadData({
          path: key,
          data: file,
          options: {
            bucket: SOURCE_BUCKET_TARGET,
            onProgress: ({transferredBytes, totalBytes}) => {
              if (!totalBytes) return;
              updatePending(tempId, {progress: Math.round((transferredBytes / totalBytes) * 100)});
            },
          },
        });
        await task.result;
        updatePending(tempId, {status: "processing", key, progress: 100});
        resolveImageInfo(tempId, key);
      } catch (err) {
        updatePending(tempId, {status: "error", errorMessage: err.message || "Upload failed"});
      }
    },
    [workId, updatePending, resolveImageInfo],
  );

  const handleFiles = useCallback(
    (files) => {
      const images = files.filter((file) => file.type.startsWith("image/"));
      const items = images.map((file) => ({
        tempId: crypto.randomUUID(),
        file,
        key: null,
        label: assetLabelFromKey(file.name),
        status: "uploading",
        progress: 0,
        previewUrl: URL.createObjectURL(file),
        imageInfo: null,
        errorMessage: null,
      }));
      if (items.length === 0) return;
      setPending((prev) => [...prev, ...items]);
      items.forEach((item) => uploadFile(item.tempId, item.file));
    },
    [uploadFile],
  );

  const handleZoneClick = () => {
    if (disabled) return;
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (event) => {
    handleFiles(Array.from(event.target.files || []));
    event.target.value = "";
  };

  const handleDragOver = (event) => {
    if (disabled) return;
    event.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    setDragActive(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragActive(false);
    if (disabled) return;
    handleFiles(Array.from(event.dataTransfer.files || []));
  };

  const updateLabel = (tempId, value) => {
    updatePending(tempId, {label: value});
  };

  const removePending = (tempId) => {
    setPending((prev) => {
      const item = prev.find((entry) => entry.tempId === tempId);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((entry) => entry.tempId !== tempId);
    });
  };

  const handleAttachClick = async () => {
    const ready = pending.filter((item) => item.status === "ready");
    if (ready.length === 0) return;
    setAttaching(true);
    setAttachError(null);
    try {
      const canvases = ready.map((item) => buildCanvasResource(manifest, item.imageInfo, item.label));
      await onAttach(canvases);
      const readyIds = new Set(ready.map((item) => item.tempId));
      setPending((prev) => {
        prev.filter((item) => readyIds.has(item.tempId)).forEach((item) => URL.revokeObjectURL(item.previewUrl));
        return prev.filter((item) => !readyIds.has(item.tempId));
      });
    } catch (err) {
      setAttachError(err.message || "Unable to save assets");
    } finally {
      setAttaching(false);
    }
  };

  const hasReadyItems = pending.some((item) => item.status === "ready");

  return (
    <Box className="asset-dropzone-panel">
      <Box
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        className={`asset-dropzone ${dragActive ? "asset-dropzone--active" : ""} ${disabled ? "asset-dropzone--disabled" : ""}`}
        onClick={handleZoneClick}
        onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && handleZoneClick()}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <UploadIcon width="20" height="20" />
        <Text as="p" size="2" color={disabled ? "gray" : undefined}>
          {disabled
            ? disabledReason || "Uploads unavailable."
            : "Drag and drop images here, or click to browse."}
        </Text>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="asset-dropzone-input"
          onChange={handleFileInputChange}
          disabled={disabled}
          tabIndex={-1}
        />
      </Box>

      {pending.length > 0 && (
        <Flex direction="column" gap="2" className="asset-dropzone-pending">
          {pending.map((item) => {
            const thumbnailUrl = item.imageInfo ? buildThumbnailUrlFromInfo(item.imageInfo) : null;
            const previewSrc = thumbnailUrl || item.previewUrl;
            return (
              <Flex key={item.tempId} align="center" gap="3" className="asset-dropzone-pending-item">
                <PendingPreview key={previewSrc} src={previewSrc} />
                <Box className="asset-dropzone-pending-info">
                  <Text as="p" size="1" color="gray" className="asset-dropzone-filename">{item.file.name}</Text>
                  {item.status === "uploading" && <Progress value={item.progress} max={100} size="1" />}
                  {(item.status === "processing" || item.status === "ready") && (
                    <TextField.Root
                      size="1"
                      value={item.label}
                      onChange={(event) => updateLabel(item.tempId, event.target.value)}
                      placeholder="Asset label"
                    />
                  )}
                  {item.status === "processing" && (
                    <Flex align="center" gap="2" mt="1">
                      <Progress size="1" duration="2s" className="asset-dropzone-processing-bar" />
                      <Text size="1" color="gray" className="asset-dropzone-processing-label">Processing image…</Text>
                    </Flex>
                  )}
                  {item.status === "error" && (
                    <Text as="p" size="1" color="red">{item.errorMessage}</Text>
                  )}
                </Box>
                <IconButton
                  type="button"
                  variant="soft"
                  color="gray"
                  size="1"
                  onClick={() => removePending(item.tempId)}
                  aria-label="Remove"
                >
                  <TrashIcon />
                </IconButton>
              </Flex>
            );
          })}
          {attachError && (
            <Callout.Root color="red" size="1">
              <Callout.Text>{attachError}</Callout.Text>
            </Callout.Root>
          )}
          <Flex justify="end">
            <Button type="button" onClick={handleAttachClick} loading={attaching} disabled={attaching || !hasReadyItems}>
              Add to work
            </Button>
          </Flex>
        </Flex>
      )}
    </Box>
  );
}
