import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";

export function webPushNotificationUrl(cfg: OpenClawConfig, path: string): string {
  // The PWA owns its worker scope; the Gateway mount is connection metadata.
  const relativePath = path.replace(/^\//u, "");
  const publicOrigin = resolveGatewayPublicOrigin(cfg);
  if (!publicOrigin) {
    return relativePath;
  }
  const basePath = normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath);
  const gatewayUrl = `${publicOrigin.replace(/^https:/u, "wss:").replace(/^http:/u, "ws:")}${basePath}`;
  return `${relativePath}#${new URLSearchParams({ gatewayUrl })}`;
}
