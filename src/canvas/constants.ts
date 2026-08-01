import type { PluginNodeCapabilitySurface } from "../gateway/plugin-node-capability.js";

/** Stable Gateway path used by chat clients for hosted Canvas content. */
const CANVAS_HOST_PATH = "/__openclaw__/canvas";
export const CANVAS_DOCUMENTS_PATH = `${CANVAS_HOST_PATH}/documents`;

/** Keep the historical Canvas plugin scope so existing capability URLs remain valid. */
const CANVAS_NODE_CAPABILITY: PluginNodeCapabilitySurface = {
  surface: "canvas",
  scopeKey: "canvas:canvas",
};

/** Returns true only for the core-owned Canvas document subtree. */
export function isCanvasDocumentHttpPath(pathname: string): boolean {
  return pathname.startsWith(`${CANVAS_DOCUMENTS_PATH}/`);
}

/** Resolves auth for any canonicalized candidate targeting core Canvas documents. */
export function resolveCanvasNodeCapability(
  pathCandidates: readonly string[],
): PluginNodeCapabilitySurface | undefined {
  return pathCandidates.some(isCanvasDocumentHttpPath) ? CANVAS_NODE_CAPABILITY : undefined;
}

/** Adds the core Canvas surface while removing stale plugin-owned duplicates. */
export function withCoreCanvasNodeCapability(
  surfaces: readonly PluginNodeCapabilitySurface[],
  enabled = true,
): PluginNodeCapabilitySurface[] {
  const withoutStaleCanvas = surfaces.filter(
    (entry) => entry.surface.trim() !== CANVAS_NODE_CAPABILITY.surface,
  );
  return enabled ? [CANVAS_NODE_CAPABILITY, ...withoutStaleCanvas] : withoutStaleCanvas;
}
