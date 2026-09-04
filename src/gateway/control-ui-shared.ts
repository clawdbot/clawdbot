// Browser-safe Control UI base-path normalization shared by route contracts and Gateway callers.
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Normalizes a Control UI base path to either "" or a leading-slash path without trailing slash. */
export function normalizeControlUiBasePath(basePath?: string | null): string {
  const value = basePath?.trim() ?? "";
  if (!value || value === "/") {
    return "";
  }
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

/** Keeps push navigation in the receiving PWA while selecting its originating Gateway. */
export function resolveControlUiWebPushUrl(cfg: OpenClawConfig, relativePath: string): string {
  const publicOrigin = resolveGatewayPublicOrigin(cfg);
  if (!publicOrigin) {
    return relativePath;
  }
  // A remote Gateway's base path may differ from the PWA's service-worker scope.
  const basePath = normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath);
  const gatewayUrl = `${publicOrigin.replace(/^https:/u, "wss:").replace(/^http:/u, "ws:")}${basePath}`;
  return `${relativePath}#${new URLSearchParams({ gatewayUrl })}`;
}
