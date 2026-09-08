import { normalizeControlUiBasePath } from "./control-ui-shared.js";

export const CONTROL_UI_BUILD_ID_ATTRIBUTE = "data-openclaw-control-ui-build-id";

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

/** Public build inputs covered by the document's content-bound cache identity. */
export function isControlUiVersionedPublicAsset(value: string): boolean {
  return (
    (isControlUiRootPublicAsset(value) && value !== "sw.js") ||
    /^(?:fonts\/[^/]+\.(?:css|woff2)|themes\/[^/]+\.css|(?:provider-icons|file-icons(?:\/[^/]+)*)\/[^/]+\.svg|(?:plugin-art|app-art|community-art)\/[^/]+\.webp)$/u.test(
      value,
    )
  );
}

export function buildControlUiRootAssetPath(
  basePath: string | null | undefined,
  asset: ControlUiRootPublicAsset,
): string {
  return `${normalizeControlUiBasePath(basePath)}/${asset}`;
}
