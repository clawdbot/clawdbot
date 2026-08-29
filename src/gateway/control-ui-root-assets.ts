import { normalizeControlUiBasePath } from "./control-ui-shared.js";

/** Root files emitted by the Control UI build and served under any configured mount. */
export const CONTROL_UI_ROOT_PUBLIC_ASSETS = [
  "apple-touch-icon.png",
  "favicon-32.png",
  "favicon.ico",
  "favicon.svg",
  "manifest.webmanifest",
  "sw.js",
] as const;
export type ControlUiRootPublicAsset = (typeof CONTROL_UI_ROOT_PUBLIC_ASSETS)[number];

export function isControlUiRootPublicAsset(value: string): value is ControlUiRootPublicAsset {
  return CONTROL_UI_ROOT_PUBLIC_ASSETS.some((asset) => asset === value);
}

export function buildControlUiRootAssetPath(
  basePath: string | null | undefined,
  asset: ControlUiRootPublicAsset,
): string {
  return `${normalizeControlUiBasePath(basePath)}/${asset}`;
}
