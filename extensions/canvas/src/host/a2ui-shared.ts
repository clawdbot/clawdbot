/** Stable hosted paths for Canvas-owned widget resources. */

/** Hosted path prefix for bundled A2UI renderer assets. */
export const A2UI_PATH = "/__openclaw__/a2ui";

/** Hosted path prefix for managed widget documents. */
export const CANVAS_HOST_PATH = "/__openclaw__/canvas";

/** Returns whether a URL path targets the hosted A2UI asset surface. */
export function isA2uiPath(pathname: string): boolean {
  return pathname === A2UI_PATH || pathname.startsWith(`${A2UI_PATH}/`);
}
