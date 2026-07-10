// Control UI module implements public assets behavior.
import { normalizeBasePath } from "../app-route-paths.ts";
import { resolveControlUiBasePath } from "./browser.ts";

type ControlUiPublicAsset =
  | "apple-touch-icon.png"
  | "favicon-32.png"
  | "favicon.ico"
  | "favicon.svg"
  | "manifest.webmanifest"
  | "sw.js"
  | `provider-icons/ProviderIcon-${string}.svg`
  | `plugin-art/${string}.webp`;

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
  const basePath =
    params?.basePath ?? resolveControlUiBasePath(params?.pathname ?? currentPathname());
  return controlUiPublicAssetPath(asset, basePath);
}

function currentPathname(): string {
  if (typeof window === "undefined") {
    return "/";
  }
  return window.location.pathname;
}
