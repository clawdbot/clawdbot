function hashWidgetIdentity(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function canvasWidgetNameForDocument(docId: string): string {
  const name = `canvas-${docId.toLowerCase().replace(/[^a-z0-9._-]/gu, "-")}`;
  if (name === `canvas-${docId}` && name.length <= 64) {
    return name;
  }
  const prefix = name.slice(0, 47).replace(/[._-]+$/gu, "") || "canvas-widget";
  return `${prefix}-${hashWidgetIdentity(docId)}`;
}

export function mcpAppWidgetNameForViewId(viewId: string): string {
  return `mcp-app-${hashWidgetIdentity(viewId)}`;
}
