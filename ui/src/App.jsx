import {useCallback, useEffect, useMemo, useState} from "react";
import {Amplify} from "aws-amplify";
import {fetchAuthSession} from "aws-amplify/auth";
import {StorageBrowser} from "./storageBrowser";
import Image from "@samvera/clover-iiif/image";
import "@aws-amplify/ui-react/styles.css";
import "@aws-amplify/ui-react-storage/styles.css";
import "./App.css";
import {trimTileChildren} from "./utils/tree";

const BACKEND = import.meta.env.VITE_BACKEND || "local";
const IIIF_BASE_URL = (import.meta.env.VITE_IIIF_BASE_URL || "").replace(/\/$/, "");
const REMOTE_MANIFEST_API_BASE = (import.meta.env.VITE_MANIFEST_API_URL || "").replace(/\/$/, "");
const STORAGE_BUCKET = import.meta.env.VITE_STORAGE_BUCKET || "";
const STORAGE_REGION = import.meta.env.VITE_STORAGE_REGION || import.meta.env.VITE_AWS_REGION || "";
const STORAGE_IDENTITY_POOL_ID = import.meta.env.VITE_STORAGE_IDENTITY_POOL_ID || "";
const COGNITO_USER_POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID || "";
const COGNITO_CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || "";
const LOCAL_MANIFEST_API_BASE = "/api/manifests";

if (BACKEND === "aws" && STORAGE_BUCKET && STORAGE_REGION) {
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
  if (BACKEND !== "aws") return {};
  try {
    const { tokens } = await fetchAuthSession();
    return tokens?.idToken ? { Authorization: tokens.idToken.toString() } : {};
  } catch {
    return {};
  }
}

const DIRECTORY_TYPES = [
  {key: "source", label: "Source Directory"},
  {key: "output", label: "Output Directory"},
];

function slugifyManifestId(value) {
  return (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function collectInfoNodes(node, acc = []) {
  if (!node) return acc;
  if (node.type === "file" && node.name?.toLowerCase() === "info.json") {
    const parent = node.path.replace(/\/info\.json$/i, "");
    acc.push({
      path: node.path,
      label: node.displayName || parent.split("/").pop() || node.name,
      parent,
    });
    return acc;
  }
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => collectInfoNodes(child, acc));
  }
  return acc;
}

function buildCanvasResource(manifest, imageInfo, label) {
  if (!manifest?.id) {
    throw new Error("Manifest is missing an id");
  }
  if (!imageInfo?.id) {
    throw new Error("Image info is missing an id");
  }
  const manifestBase = manifest.id.replace(/\/manifest\.json$/i, "");
  const normalizedLabel = label?.trim() || "Canvas";
  const slugBase = slugifyManifestId(normalizedLabel) || slugifyManifestId(imageInfo.id.split("/").pop() || "");
  const uniqueSlug = slugBase ? `${slugBase}-${Date.now().toString(36)}` : Date.now().toString(36);
  const canvasId = `${manifestBase}/canvas/${uniqueSlug}`;
  const pageId = `${canvasId}/page/1`;
  const annotationId = `${canvasId}/annotation/1`;
  const serviceId = imageInfo.id.replace(/\/$/, "");
  const imageService = {
    id: serviceId,
    type: imageInfo.type || "ImageService3",
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
              id: `${serviceId}/full/max/0/default.jpg`,
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

function AwsImageLookup({onSelect}) {
  const [value, setValue] = useState(IIIF_BASE_URL ? `${IIIF_BASE_URL}/` : "");

  function handleSubmit(e) {
    e.preventDefault();
    const url = value.trim().replace(/\/info\.json$/, "").replace(/\/$/, "");
    if (url) onSelect(url);
  }

  return (
    <section className="panel">
      <header>
        <h2>IIIF Image URL</h2>
      </header>
      <div className="panel-body">
        <form onSubmit={handleSubmit} className="url-form">
          <input
            type="text"
            className="url-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="https://…/iiif/2/image%2Fidentifier"
            spellCheck={false}
          />
          <button type="submit">Preview</button>
        </form>
      </div>
    </section>
  );
}

function TreeNode({node, onSelectInfo}) {
  if (!node) return null;
  if (node.type === "directory") {
    return (
      <div className="tree-node">
        {node.name && <div className="tree-dir">{node.name}</div>}
        <div className="tree-children">
          {node.children && node.children.length > 0 ? (
            node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                onSelectInfo={onSelectInfo}
              />
            ))
          ) : (
            <span className="tree-empty">(empty)</span>
          )}
        </div>
      </div>
    );
  }

  const isInfo = node.name?.toLowerCase().endsWith("info.json");

  const handleSelect = () => {
    if (isInfo && onSelectInfo) {
      onSelectInfo(node.path);
    }
  };

  return (
    <div className={`tree-file ${isInfo ? "tree-file--info" : ""}`}>
      {isInfo ? (
        <button type="button" onClick={handleSelect}>
          {node.displayName || node.name}
        </button>
      ) : (
        <span>{node.displayName || node.name}</span>
      )}
    </div>
  );
}

function DirectoryPanel({title, tree, onSelectInfo}) {
  return (
    <section className="panel">
      <header>
        <h2>{title}</h2>
      </header>
      <div className="panel-body">
        {tree ? (
          <TreeNode node={tree} onSelectInfo={onSelectInfo} />
        ) : (
          <span className="tree-empty">No data</span>
        )}
      </div>
    </section>
  );
}

function AwsStorageBrowserPanel({ready}) {
  return (
    <section className="panel storage-panel">
      <header>
        <h2>S3 Storage Browser</h2>
      </header>
      <div className="panel-body storage-panel-body">
        {ready ? (
          <div className="storage-browser-wrapper">
            <StorageBrowser />
          </div>
        ) : (
          <div className="storage-browser-placeholder">
            Provide `VITE_STORAGE_BUCKET` and `VITE_STORAGE_REGION` to enable
            the Amplify Storage Browser.
          </div>
        )}
      </div>
    </section>
  );
}

function ManifestList({manifests, selectedId, onSelect}) {
  if (!manifests || manifests.length === 0) {
    return <div className="tree-empty">No manifests yet.</div>;
  }

  return (
    <ul className="manifest-list">
      {manifests.map((manifest) => {
        const isActive = manifest.identifier === selectedId;
        const canvasCount = Number.isFinite(manifest.itemCount)
          ? manifest.itemCount
          : Array.isArray(manifest.manifest?.items)
            ? manifest.manifest.items.length
            : 0;
        return (
          <li key={manifest.identifier}>
            <button
              type="button"
              className={`manifest-list-item ${isActive ? "manifest-list-item--active" : ""}`}
              onClick={() => onSelect(manifest.identifier)}
            >
              <strong>{manifest.label || manifest.identifier}</strong>
              <span>ID: {manifest.identifier}</span>
              <span>
                {canvasCount} {canvasCount === 1 ? "canvas" : "canvases"}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
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
    return <div className="manifest-detail-placeholder">Loading manifest…</div>;
  }

  if (error) {
    return <div className="status status--error">{error}</div>;
  }

  if (!detail) {
    return <div className="manifest-detail-placeholder">Select a manifest to edit canvases.</div>;
  }

  const canvasCount = Array.isArray(detail.manifest?.items)
    ? detail.manifest.items.length
    : 0;

  const canvases = Array.isArray(detail.manifest?.items)
    ? detail.manifest.items
    : [];

  return (
    <div className="manifest-detail">
      <div className="manifest-detail-header">
        <div className="manifest-detail-meta">
          <h3>{detail.label || detail.identifier}</h3>
          <code>{detail.manifestUrl}</code>
        </div>
        <button
          type="button"
          onClick={onAddCanvas}
          disabled={!canAddCanvas}
          title={!canAddCanvas && disableAddReason ? disableAddReason : undefined}
        >
          Add Canvas
        </button>
      </div>
      {disableAddReason && !canAddCanvas && (
        <p className="manifest-detail-hint">{disableAddReason}</p>
      )}
      {canvasActionError && (
        <div className="status status--error">{canvasActionError}</div>
      )}
      {canvasSaving && <div className="status">Saving canvases…</div>}
      <div className="manifest-detail-body">
        {canvases.length === 0 ? (
          <p>
            {canAddCanvas
              ? "No canvases yet. Add one to start building the viewing order."
              : "No canvases yet."}
          </p>
        ) : (
          <ul className="canvas-list">
            {canvases.map((canvas, index) => (
              <li key={canvas.id || `${index}`} className="canvas-list-item">
                <div className="canvas-list-info">
                  <strong>{canvas.label?.none?.[0] || `Canvas ${index + 1}`}</strong>
                  <span>
                    {canvas.items?.[0]?.items?.[0]?.body?.service?.[0]?.id ||
                      canvas.items?.[0]?.items?.[0]?.body?.id ||
                      ""}
                  </span>
                </div>
                <div className="canvas-list-actions">
                  <button
                    type="button"
                    onClick={() => onReorderCanvas(index, -1)}
                    disabled={index === 0 || canvasSaving}
                    aria-label="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => onReorderCanvas(index, 1)}
                    disabled={index === canvases.length - 1 || canvasSaving}
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveCanvas(index)}
                    disabled={canvasSaving}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ManifestModal({open, onClose, onSubmit, form, onChange, submitting, error}) {
  if (!open) return null;

  const handleChange = (evt) => {
    const {name, value} = evt.target;
    onChange(name, value);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true">
        <header>
          <h3>Create Manifest</h3>
        </header>
        <form onSubmit={onSubmit} className="modal-form">
          <label>
            <span>Title (label)</span>
            <input
              name="label"
              type="text"
              required
              value={form.label}
              onChange={handleChange}
              placeholder="e.g. 1973 yearbook"
            />
          </label>
          <label>
            <span>ID</span>
            <input
              name="identifier"
              type="text"
              required
              value={form.identifier}
              onChange={handleChange}
              placeholder="e.g. 1973-yearbook"
            />
          </label>
          {error && <div className="status status--error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="button-secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Next"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AddCanvasModal({
  open,
  onClose,
  onSubmit,
  form,
  onChange,
  images,
  submitting,
  error,
  allowManualInput = false,
}) {
  if (!open) return null;

  const handleChange = (evt) => {
    const {name, value} = evt.target;
    onChange(name, value);
  };

  const hasImageOptions = Array.isArray(images) && images.length > 0;
  const showManualInput = allowManualInput || !hasImageOptions;

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true">
        <header>
          <h3>Add Canvas</h3>
        </header>
        <form onSubmit={onSubmit} className="modal-form">
          {hasImageOptions && (
            <label>
              <span>Image</span>
              <select
                name="imagePath"
                value={form.imagePath}
                onChange={handleChange}
                required={!showManualInput}
                disabled={submitting}
              >
                <option value="" disabled>
                  Choose an image
                </option>
                {images.map((image) => (
                  <option key={image.path} value={image.path}>
                    {image.label} — {image.parent}
                  </option>
                ))}
              </select>
            </label>
          )}
          {showManualInput && (
            <label>
              <span>IIIF info.json URL</span>
              <input
                name="imageUrl"
                type="url"
                value={form.imageUrl || ""}
                onChange={handleChange}
                placeholder="https://example.com/iiif/.../info.json"
                disabled={submitting}
                required={!hasImageOptions}
              />
            </label>
          )}
          <label>
            <span>Canvas label</span>
            <input
              name="label"
              type="text"
              value={form.label}
              onChange={handleChange}
              placeholder="e.g. Page 1"
              disabled={submitting}
            />
          </label>
          {error && <div className="status status--error">{error}</div>}
          <div className="modal-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                submitting ||
                (!hasImageOptions && !form.imageUrl) ||
                (hasImageOptions && !form.imagePath && !showManualInput)
              }
            >
              {submitting ? "Adding…" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function App({ signOut }) {
  const isLocalBackend = BACKEND === "local";
  const isAwsBackend = BACKEND === "aws";
  const manifestApiBase = isAwsBackend ? REMOTE_MANIFEST_API_BASE : LOCAL_MANIFEST_API_BASE;
  const manifestApiAvailable = Boolean(manifestApiBase);
  const storageBrowserReady = Boolean(STORAGE_BUCKET && STORAGE_REGION);
  const [trees, setTrees] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedInfoPath, setSelectedInfoPath] = useState(null);
  const [selectedInfo, setSelectedInfo] = useState(null);
  const [viewerError, setViewerError] = useState(null);
  const [manifests, setManifests] = useState([]);
  const [manifestLoading, setManifestLoading] = useState(manifestApiAvailable);
  const [manifestError, setManifestError] = useState(null);
  const [selectedManifestId, setSelectedManifestId] = useState(null);
  const [manifestDetail, setManifestDetail] = useState(null);
  const [manifestDetailLoading, setManifestDetailLoading] = useState(false);
  const [manifestDetailError, setManifestDetailError] = useState(null);
  const [isManifestModalOpen, setManifestModalOpen] = useState(false);
  const [manifestForm, setManifestForm] = useState({label: "", identifier: ""});
  const [manifestFormError, setManifestFormError] = useState(null);
  const [manifestFormSubmitting, setManifestFormSubmitting] = useState(false);
  const [isCanvasModalOpen, setCanvasModalOpen] = useState(false);
  const [canvasForm, setCanvasForm] = useState({imagePath: "", imageUrl: "", label: ""});
  const [canvasModalError, setCanvasModalError] = useState(null);
  const [canvasModalSubmitting, setCanvasModalSubmitting] = useState(false);
  const [canvasSaving, setCanvasSaving] = useState(false);
  const [canvasActionError, setCanvasActionError] = useState(null);

  const availableImages = useMemo(() => {
    if (!isLocalBackend || !trees.output) return [];
    return collectInfoNodes(trees.output, []).map((entry) => ({
      ...entry,
      identifier: entry.parent.split("/").pop() || entry.label,
    }));
  }, [isLocalBackend, trees.output]);

  const manifestApiUrl = useCallback(
    (path = "") => {
      if (!manifestApiBase) return null;
      const suffix = path ? `/${path.replace(/^\/+/, "")}` : "";
      return `${manifestApiBase}${suffix}`;
    },
    [manifestApiBase],
  );

  const refreshManifests = useCallback(async () => {
    if (!manifestApiAvailable) {
      setManifests([]);
      setManifestError(
        isAwsBackend
          ? "Manifest API URL is not configured. Set VITE_MANIFEST_API_URL and redeploy."
          : null,
      );
      setManifestLoading(false);
      return;
    }
    setManifestLoading(true);
    setManifestError(null);
    try {
      const endpoint = manifestApiUrl();
      if (!endpoint) {
        throw new Error("Manifest API unavailable");
      }
      const response = await fetch(endpoint, { headers: await authHeaders() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to load manifests");
      }
      setManifests(Array.isArray(data.manifests) ? data.manifests : []);
    } catch (err) {
      setManifests([]);
      setManifestError(err.message);
    } finally {
      setManifestLoading(false);
    }
  }, [isAwsBackend, manifestApiAvailable, manifestApiUrl]);

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
        throw new Error("Manifest API unavailable");
      }
      const response = await fetch(endpoint, { headers: await authHeaders() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to load manifest");
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

  const handleCanvasFieldChange = useCallback(
    (name, value) => {
      setCanvasForm((prev) => {
        if (name === "imagePath") {
          const selected = availableImages.find((img) => img.path === value);
          const fallbackLabel = prev.label.trim() ? prev.label : selected?.label || "";
          return {...prev, imagePath: value, label: fallbackLabel};
        }
        if (name === "imageUrl") {
          return {...prev, imageUrl: value};
        }
        return {...prev, [name]: value};
      });
    },
    [availableImages],
  );

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
        throw new Error("Manifest API unavailable");
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {"Content-Type": "application/json", ...(await authHeaders())},
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to create manifest");
      }
      await refreshManifests();
      setSelectedManifestId(data.manifest?.identifier || payload.identifier);
      setManifestModalOpen(false);
    } catch (err) {
      setManifestFormError(err.message);
    } finally {
      setManifestFormSubmitting(false);
    }
  };

  const handleOpenCanvasModal = () => {
    if (!manifestDetail) return;
    if (isLocalBackend) {
      if (!availableImages.length) return;
      const defaultPath = availableImages[0]?.path || "";
      const selected = availableImages.find((img) => img.path === (canvasForm.imagePath || defaultPath));
      setCanvasForm({
        imagePath: selected?.path || defaultPath,
        imageUrl: "",
        label: selected?.label || "",
      });
    } else {
      setCanvasForm((prev) => ({
        imagePath: "",
        imageUrl: prev.imageUrl || "",
        label: prev.label || "",
      }));
    }
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
        throw new Error("Select a manifest first");
      }
      setCanvasSaving(true);
      setCanvasActionError(null);
      try {
        const endpoint = manifestApiUrl(`${encodeURIComponent(selectedManifestId)}/items`);
        if (!endpoint) {
          throw new Error("Manifest API unavailable");
        }
        const response = await fetch(endpoint, {
          method: "PUT",
          headers: {"Content-Type": "application/json", ...(await authHeaders())},
          body: JSON.stringify({items}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "Unable to save canvases");
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
      setCanvasModalError("Select a manifest first");
      return;
    }
    setCanvasModalSubmitting(true);
    setCanvasModalError(null);
    try {
      let infoUrl;
      if (isLocalBackend) {
        if (!canvasForm.imagePath) {
          setCanvasModalError("Choose an image to add");
          setCanvasModalSubmitting(false);
          return;
        }
        infoUrl = `/iiif/output/${canvasForm.imagePath}`;
      } else {
        const providedUrl = (canvasForm.imageUrl || "").trim();
        if (!providedUrl) {
          setCanvasModalError("Enter a IIIF info.json URL");
          setCanvasModalSubmitting(false);
          return;
        }
        infoUrl = providedUrl;
      }
      const response = await fetch(infoUrl);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to load image info");
      }
      const selected = availableImages.find((img) => img.path === canvasForm.imagePath);
      const derivedLabelFromUrl = () => {
        const trimmed = infoUrl.split("/").filter(Boolean).pop() || "canvas";
        return trimmed.replace(/info\.json$/i, "");
      };
      const label = canvasForm.label.trim()
        || selected?.label
        || derivedLabelFromUrl()
        || "Untitled canvas";
      const nextCanvas = buildCanvasResource(manifestDetail.manifest, data, label);
      const nextItems = [...(manifestDetail.manifest.items || []), nextCanvas];
      await persistManifestItems(nextItems);
      setCanvasModalOpen(false);
      setCanvasForm({imagePath: "", imageUrl: "", label: ""});
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
    if (BACKEND === "aws") {
      setLoading(false);
      return;
    }
    async function fetchTrees() {
      setLoading(true);
      setError(null);
      try {
        const responses = await Promise.all(
          DIRECTORY_TYPES.map(async ({key}) => {
            const response = await fetch(`/api/tree?type=${key}`);
            if (!response.ok) {
              throw new Error(`Failed to load ${key} tree`);
            }
            const data = await response.json();
            return [key, trimTileChildren(data.tree)];
          }),
        );
        setTrees(Object.fromEntries(responses));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    fetchTrees();
  }, []);

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
    async function fetchInfo(relativePath) {
      if (!relativePath) {
        setSelectedInfo(null);
        return;
      }
      setViewerError(null);
      try {
        const infoUrl = `/iiif/output/${relativePath}`;
        const serviceUrl = infoUrl.replace(/\/info\.json$/u, "");
        const response = await fetch(infoUrl);
        if (!response.ok) {
          throw new Error(`Unable to load ${relativePath}`);
        }
        const data = await response.json();
        const normalizedData = {
          ...data,
          id: serviceUrl,
        };
        setSelectedInfo({data: normalizedData, infoUrl, serviceUrl});
      } catch (err) {
        setViewerError(err.message);
        setSelectedInfo(null);
      }
    }

    fetchInfo(selectedInfoPath);
  }, [selectedInfoPath]);

  function handleAwsSelect(serviceUrl) {
    setViewerError(null);
    fetch(`${serviceUrl}/info.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`Unable to load info.json from ${serviceUrl}`);
        return res.json();
      })
      .then((data) => setSelectedInfo({data: {...data, id: serviceUrl}, infoUrl: `${serviceUrl}/info.json`, serviceUrl}))
      .catch((err) => {
        setViewerError(err.message);
        setSelectedInfo(null);
      });
  }

  const viewer = useMemo(() => {
    if (!selectedInfo) return null;
    return (
      <div className="viewer">
        <div className="viewer-header">
          <h2>IIIF Preview</h2>
          <p>{selectedInfo.data.id || selectedInfo.serviceUrl}</p>
        </div>
        <div
          className="viewer-stage"
          style={{
            width: "100%",
            height: "50vh",
          }}
        >
          <Image
            key={selectedInfo.serviceUrl}
            src={selectedInfo.serviceUrl}
            isTiledImage
          />
        </div>
        <div className="viewer-meta">
          <p>
            Dimensions: {selectedInfo.data.width} × {selectedInfo.data.height}px
          </p>
          <p>Profile: {Array.isArray(selectedInfo.data.profile) ? selectedInfo.data.profile[0] : selectedInfo.data.profile}</p>
        </div>
      </div>
    );
  }, [selectedInfo]);

  const canAddCanvas = Boolean(manifestDetail) && manifestApiAvailable && (isLocalBackend ? availableImages.length > 0 : true);
  const disableAddReason = (() => {
    if (!manifestDetail) return null;
    if (!manifestApiAvailable) {
      return "Manifest API unavailable.";
    }
    if (isLocalBackend && availableImages.length === 0) {
      return "Process at least one IIIF image to add canvases.";
    }
    return null;
  })();

  return (
    <main className="layout">
      <header className="layout-header">
        <h1>Static IIIF Dashboard**</h1>
        <p>
          Browse input/output directories and preview generated Image API
          services.
        </p>
        {loading && <span className="status">Loading directories…</span>}
        {error && <span className="status status--error">{error}</span>}
        {isAwsBackend && signOut && (
          <button type="button" onClick={signOut} className="signout-button">Sign out</button>
        )}
      </header>
      {BACKEND === "aws" ? (
        <div className="columns">
          <AwsImageLookup onSelect={handleAwsSelect} />
          <AwsStorageBrowserPanel ready={storageBrowserReady} />
        </div>
      ) : (
        <div className="columns">
          {DIRECTORY_TYPES.map(({key, label}) => (
            <DirectoryPanel
              key={key}
              title={label}
              tree={trees[key]}
              onSelectInfo={key === "output" ? setSelectedInfoPath : undefined}
            />
          ))}
        </div>
      )}
      {(isLocalBackend || isAwsBackend) && (
        <section className="panel manifest-panel">
          <header className="manifest-panel-header">
            <h2>Presentation Manifests</h2>
            <button
              type="button"
              onClick={handleOpenManifestModal}
              disabled={!manifestApiAvailable}
            >
              Add Manifest
            </button>
          </header>
          <div className="panel-body manifest-panel-body">
            {!manifestApiAvailable && (
              <div className="status status--error">
                {isAwsBackend
                  ? "Manifest API URL is not configured. Update VITE_MANIFEST_API_URL to point at the deployed endpoint."
                  : "Manifest tools unavailable."}
              </div>
            )}
            {manifestError && manifestApiAvailable && (
              <div className="status status--error">{manifestError}</div>
            )}
            <div className="manifest-content">
              <div className="manifest-column manifest-column--list">
                {manifestLoading ? (
                  <span className="status">Loading manifests…</span>
                ) : (
                  <ManifestList
                    manifests={manifests}
                    selectedId={selectedManifestId}
                    onSelect={setSelectedManifestId}
                  />
                )}
              </div>
              <div className="manifest-column manifest-column--detail">
                <ManifestDetail
                  detail={manifestDetail}
                  loading={manifestDetailLoading}
                  error={manifestDetailError}
                  onAddCanvas={handleOpenCanvasModal}
                  canAddCanvas={canAddCanvas}
                  onReorderCanvas={handleReorderCanvas}
                  onRemoveCanvas={handleRemoveCanvas}
                  canvasSaving={canvasSaving}
                  canvasActionError={canvasActionError}
                  disableAddReason={disableAddReason}
                />
              </div>
            </div>
          </div>
        </section>
      )}
      <section className="panel viewer-panel">
        {selectedInfo ? (
          viewer
        ) : (
          <div className="viewer-placeholder">
            {BACKEND === "aws"
              ? "Enter a IIIF image URL above to preview."
              : "Select an `info.json` in the output tree to preview."}
          </div>
        )}
        {viewerError && (
          <div className="status status--error">{viewerError}</div>
        )}
      </section>
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
        images={availableImages}
        submitting={canvasModalSubmitting}
        error={canvasModalError}
        allowManualInput={!isLocalBackend}
      />
    </main>
  );
}
