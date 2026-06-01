import type { GatewayAuthMode, GatewayTailscaleMode } from "../config/types.gateway.js";

/** True when Tailscale exposure is configured without gateway authentication. */
export function isUnsafeGatewayTailscaleNoAuth(params: {
  authMode?: GatewayAuthMode;
  tailscaleMode?: GatewayTailscaleMode;
}): boolean {
  return (
    params.authMode === "none" &&
    (params.tailscaleMode === "serve" || params.tailscaleMode === "funnel")
  );
}

/** Formats the shared validation message for unsafe Tailscale no-auth exposure. */
export function formatUnsafeGatewayTailscaleNoAuthMessage(
  tailscaleMode: GatewayTailscaleMode,
): string {
  if (tailscaleMode === "funnel") {
    return "gateway.tailscale.mode=funnel requires gateway.auth.mode=password; auth.mode=none cannot be used when exposing the gateway through Tailscale Funnel";
  }
  return `gateway.auth.mode=none cannot be used with gateway.tailscale.mode=${tailscaleMode}; configure token, password, or trusted-proxy auth before exposing the gateway through Tailscale`;
}
