import type { ControlUiRootPublicAsset } from "../../../src/gateway/control-ui-root-assets.js";
// Control UI module implements public assets behavior.
import { inferBasePathFromPathname, normalizeBasePath } from "../app-route-paths.ts";
import { resolveControlUiPaths } from "./browser.ts";

type ControlUiPublicAsset =
  | ControlUiRootPublicAsset
  | `fonts/${string}.css`
  | `themes/${string}.css`
  | `provider-icons/ProviderIcon-${string}.svg`
  | `file-icons/${string}.svg`
  | `plugin-art/${string}.webp`
  | `app-art/${string}.webp`;

export function controlUiPublicAssetPath(
  asset: ControlUiPublicAsset,
  resourceBasePath: string | null | undefined,
): string {
  return `${normalizeBasePath(resourceBasePath ?? "")}/${asset}`;
}

export function inferControlUiPublicAssetPath(
  asset: ControlUiPublicAsset,
  params?: {
    resourceBasePath?: string | null;
    pathname?: string;
  },
): string {
  const resourceBasePath =
    params?.resourceBasePath ??
    (params?.pathname === undefined
      ? resolveControlUiPaths(currentPathname())[1]
      : inferBasePathFromPathname(params.pathname));
  return controlUiPublicAssetPath(asset, resourceBasePath);
}

function currentPathname(): string {
  if (typeof window === "undefined") {
    return "/";
  }
  return window.location.pathname;
}
