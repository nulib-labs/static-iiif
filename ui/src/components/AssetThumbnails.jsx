import "./AssetThumbnails.css";

function iiifThumbnailUrl(serviceId, size) {
  return `${serviceId.replace(/\/$/, "")}/full/,${size}/0/default.jpg`;
}

function hideOnError(event) {
  event.currentTarget.style.display = "none";
}

export default function AssetThumbnails({services, size = 32, max, count, stacked = false, className}) {
  if (!Array.isArray(services) || services.length === 0) {
    return null;
  }

  const visible = typeof max === "number" ? services.slice(0, max) : services;
  const badgeCount = typeof count === "number" ? count : services.length;

  return (
    <div className={`asset-thumbnails-group ${className || ""}`}>
      <div className={`asset-thumbnails ${stacked ? "asset-thumbnails--stacked" : ""}`}>
        {visible.map((serviceId, index) => (
          <img
            key={`${serviceId}-${index}`}
            className="asset-thumbnails__item"
            src={iiifThumbnailUrl(serviceId, size)}
            alt=""
            loading="lazy"
            onError={hideOnError}
          />
        ))}
      </div>
      {stacked && badgeCount > 0 && (
        <span className="asset-thumbnails__badge">{badgeCount}</span>
      )}
    </div>
  );
}
