export function trimTileChildren(node) {
  if (!node || node.type !== "directory" || !node.children) {
    return node;
  }

  // If the directory contains an info.json, treat the directory itself as the leaf
  const hasInfo = node.children.some((child) => child.name.toLowerCase() === "info.json");
  if (hasInfo) {
    return {
      ...node,
      displayName: node.name,
      name: node.name,
      children: [
        {
          type: "file",
          name: "info.json",
          displayName: node.name,
          path: node.path ? `${node.path}/info.json` : "info.json",
        },
      ],
    };
  }

  return {
    ...node,
    children: node.children.map((child) => trimTileChildren(child)),
  };
}
