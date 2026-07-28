import "./AssetThumbnails.css";

function iiifThumbnailUrl(serviceId, size) {
  return `${serviceId.replace(/\/$/, "")}/full/,${size}/0/default.jpg`;
}

function hideOnError(event) {
  event.currentTarget.style.display = "none";
}

export default function AssetThumbnails({services, size = 32, max, className}) {
  if (!Array.isArray(services) || services.length === 0) {
    return null;
  }

  const visible = typeof max === "number" ? services.slice(0, max) : services;

  return (
    <div className={`asset-thumbnails ${className || ""}`}>
      {visible.map((serviceId, index) => (
        <img
          key={`${serviceId}-${index}`}
          className="asset-thumbnails__item"
          src={iiifThumbnailUrl(serviceId, size)}
          alt=""
          loading="lazy"
          height={size}
          onError={hideOnError}
        />
      ))}
    </div>
  );
}
