// WebSocket auth messages format client-specific handshake failures without exposing secret material.
import {
  isGatewayCliClient,
  isOperatorUiClient,
  isWebchatClient,
} from "../../../utils/message-channel.js";
import type { ResolvedGatewayAuth } from "../../auth.js";
import { PROXY_ATTRIBUTION_REQUIRED_REASON } from "../../ingress-attribution.js";

/**
 * Human-readable WebSocket auth failure messages for CLI, UI, and webchat clients.
 */
export type AuthProvidedKind = "token" | "bootstrap-token" | "device-token" | "password" | "none";

/** Formats a client-specific auth failure message without exposing secret values. */
export function formatGatewayAuthFailureMessage(params: {
  authMode: ResolvedGatewayAuth["mode"];
  authProvided: AuthProvidedKind;
  reason?: string;
  client?: { id?: string | null; mode?: string | null };
  isLocalClient?: boolean;
}): string {
  const { authMode, authProvided, reason, client, isLocalClient } = params;
  const isCli = isGatewayCliClient(client);
  const isControlUi = isOperatorUiClient(client);
  const isWebchat = isWebchatClient(client);
  if (client?.mode === "node" && reason?.startsWith("trusted_proxy_missing_header_")) {
    return "gateway rejected this node: trusted-proxy identity-header authentication is required and no usable machine credential was accepted; run `openclaw doctor` on the Gateway";
  }
  const uiHint = "open the dashboard URL and paste the token in Control UI settings";
  const missingUiTokenHint =
    "paste in Control UI settings or openclaw doctor --generate-gateway-token; restart";
  // Local CLI clients share this gateway's config and have no gateway.remote
  // block; pointing them at gateway.remote.* would be a dead end.
  const tokenHint = isCli
    ? isLocalClient
      ? "use this gateway's gateway.auth.token or pair the device"
      : "set gateway.remote.token to match gateway.auth.token"
    : isControlUi || isWebchat
      ? uiHint
      : "provide gateway auth token";
  const passwordHint = isCli
    ? isLocalClient
      ? "use this gateway's gateway.auth.password"
      : "set gateway.remote.password to match gateway.auth.password"
    : isControlUi || isWebchat
      ? "enter the password in Control UI settings"
      : "provide gateway auth password";
  switch (reason) {
    case "token_missing":
      return `unauthorized: gateway token missing (${isControlUi || isWebchat ? missingUiTokenHint : tokenHint})`;
    case "token_mismatch":
      return `unauthorized: gateway token mismatch (${tokenHint})`;
    case "token_missing_config":
      return "unauthorized: gateway token not configured on gateway (set gateway.auth.token)";
    case "password_missing":
      return `unauthorized: gateway password missing (${passwordHint})`;
    case "password_mismatch":
      return `unauthorized: gateway password mismatch (${passwordHint})`;
    case "password_missing_config":
      return "unauthorized: gateway password not configured on gateway (set gateway.auth.password)";
    case "bootstrap_token_invalid":
      return "unauthorized: bootstrap token invalid or expired (scan a fresh setup code)";
    case "tailscale_user_missing":
      return "unauthorized: tailscale identity missing (use Tailscale Serve auth or gateway token/password)";
    case "tailscale_proxy_missing":
      return "unauthorized: tailscale proxy headers missing (use Tailscale Serve or gateway token/password)";
    case "tailscale_whois_failed":
      return "unauthorized: tailscale identity check failed (use Tailscale Serve auth or gateway token/password)";
    case "tailscale_user_mismatch":
      return "unauthorized: tailscale identity mismatch (use Tailscale Serve auth or gateway token/password)";
    case "rate_limited":
      return "unauthorized: too many failed authentication attempts (retry later)";
    case PROXY_ATTRIBUTION_REQUIRED_REASON:
      return "unauthorized: proxy client attribution is required (configure gateway.trustedProxies narrowly and make the proxy overwrite or safely rebuild forwarded client headers)";
    case "device_token_mismatch":
      return "unauthorized: device token mismatch (rotate/reissue device token)";
    case "scope_mismatch":
      return "unauthorized: device token scope mismatch (re-pair or approve scope upgrade)";
    default:
      break;
  }

  if (authMode === "token" && authProvided === "none") {
    return `unauthorized: gateway token missing (${tokenHint})`;
  }
  if (authMode === "token" && authProvided === "device-token") {
    return "unauthorized: device token rejected (pair/repair this device, or provide gateway token)";
  }
  if (authProvided === "bootstrap-token") {
    return "unauthorized: bootstrap token invalid or expired (scan a fresh setup code)";
  }
  if (authMode === "password" && authProvided === "none") {
    return `unauthorized: gateway password missing (${passwordHint})`;
  }
  return "unauthorized";
}
