import {
  CONTROL_UI_BUILD_ID_ATTRIBUTE,
  type ControlUiRootPublicAsset,
} from "../../../src/gateway/control-ui-root-assets.js";
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
  | `app-art/${string}.webp`
  | `community-art/${string}.webp`;

export function controlUiPublicAssetPath(
  asset: ControlUiPublicAsset,
  resourceBasePath: string | null | undefined,
): string {
  const buildId =
    asset !== "sw.js" && typeof document !== "undefined"
      ? document.documentElement.getAttribute(CONTROL_UI_BUILD_ID_ATTRIBUTE)
      : null;
  const version = buildId ? `?v=${encodeURIComponent(buildId)}` : "";
  return `${normalizeBasePath(resourceBasePath ?? "")}/${asset}${version}`;
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
