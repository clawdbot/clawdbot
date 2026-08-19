import {
  buildControlUiRootAssetPath,
  isControlUiRootPublicAsset,
  type ControlUiRootPublicAsset,
} from "../../../src/gateway/control-ui-contract.js";
// Control UI module implements public assets behavior.
import { inferBasePathFromPathname, normalizeBasePath } from "../app-route-paths.ts";
import { resolveControlUiPaths } from "./browser.ts";

type ControlUiPublicAsset =
  | ControlUiRootPublicAsset
  | `provider-icons/ProviderIcon-${string}.svg`
  | `plugin-art/${string}.webp`
  | `app-art/${string}.webp`;

export function controlUiPublicAssetPath(
  asset: ControlUiPublicAsset,
  resourceBasePath: string | null | undefined,
): string {
  const base = normalizeBasePath(resourceBasePath ?? "");
  if (isControlUiRootPublicAsset(asset)) {
    return buildControlUiRootAssetPath(base, asset);
  }
  return base ? `${base}/${asset}` : `/${asset}`;
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
