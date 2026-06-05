// Control UI module implements public assets behavior.
import { inferBasePathFromPathname, normalizeBasePath } from "./navigation.ts";

export type ControlUiPublicAsset =
  | "apple-touch-icon.png"
  | "favicon-32.png"
  | "favicon.ico"
  | "favicon.svg"
  | "manifest.webmanifest"
  | "sw.js";

type WindowWithControlUiBasePath = Window &
  typeof globalThis & {
    [key: string]: unknown;
  };

export function controlUiPublicAssetPath(
  asset: ControlUiPublicAsset,
  basePath: string | null | undefined,
): string {
  const base = normalizeBasePath(basePath ?? "");
  return base ? `${base}/${asset}` : `/${asset}`;
}

export function inferControlUiPublicAssetPath(
  asset: ControlUiPublicAsset,
  params?: {
    basePath?: string | null;
    pathname?: string;
  },
): string {
  const configured = params?.basePath ?? readConfiguredBasePath();
  const inferredBasePath =
    configured != null
      ? configured
      : inferBasePathFromPathname(params?.pathname ?? currentPathname());
  return controlUiPublicAssetPath(asset, inferredBasePath);
}

function readConfiguredBasePath(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = (window as WindowWithControlUiBasePath)["__OPENCLAW_CONTROL_UI_BASE_PATH__"];
  return typeof value === "string" ? value : null;
}

function currentPathname(): string {
  if (typeof window === "undefined") {
    return "/";
  }
  return window.location.pathname;
}
