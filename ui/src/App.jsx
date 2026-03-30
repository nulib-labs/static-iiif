import {useEffect, useMemo, useState} from "react";
import Image from "@samvera/clover-iiif/image";
import "./App.css";
import {trimTileChildren} from "./utils/tree";

const BACKEND = import.meta.env.VITE_BACKEND || "local";
const IIIF_BASE_URL = (import.meta.env.VITE_IIIF_BASE_URL || "").replace(/\/$/, "");

const DIRECTORY_TYPES = [
  {key: "source", label: "Source Directory"},
  {key: "output", label: "Output Directory"},
];

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

export default function App() {
  const [trees, setTrees] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedInfoPath, setSelectedInfoPath] = useState(null);
  const [selectedInfo, setSelectedInfo] = useState(null);
  const [viewerError, setViewerError] = useState(null);

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
          <p>Profile: {selectedInfo.data.profile}</p>
        </div>
      </div>
    );
  }, [selectedInfo]);

  return (
    <main className="layout">
      <header className="layout-header">
        <h1>Static IIIF Dashboard</h1>
        <p>
          Browse input/output directories and preview generated Image API
          services.
        </p>
        {loading && <span className="status">Loading directories…</span>}
        {error && <span className="status status--error">{error}</span>}
      </header>
      {BACKEND === "aws" ? (
        <AwsImageLookup onSelect={handleAwsSelect} />
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
    </main>
  );
}
