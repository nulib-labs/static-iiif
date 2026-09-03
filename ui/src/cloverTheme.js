// Clover Viewer (Stitches-based) theme tokens, remapped to this app's Radix Theme
// CSS variables (see main.jsx's <Theme appearance="light" accentColor="iris" grayColor="mauve">)
// so the viewer's chrome follows the app's theme instead of Clover's own defaults.
export const CLOVER_THEME = {
  colors: {
    primary: "var(--gray-12)",
    primaryMuted: "var(--gray-11)",
    primaryAlt: "var(--gray-12)",
    accent: "var(--accent-9)",
    accentMuted: "var(--accent-8)",
    accentAlt: "var(--accent-10)",
    secondary: "var(--color-panel-solid, #fff)",
    secondaryMuted: "var(--gray-3)",
    secondaryAlt: "var(--gray-6)",
  },
};

export const CLOVER_OPTIONS = {
  showIIIFBadge: false,
  showTitle: false,
  informationPanel: {
    // Collapsed on load; renderToggle keeps the user's control to open it.
    open: false,
    renderToggle: true,
  },
};
