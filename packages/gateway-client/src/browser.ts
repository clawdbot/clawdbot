// Browser-safe gateway client surface. Keep Node transport/TLS dependencies out
// of this entry so browser consumers share the wire engine without polyfills.
export * from "./device-auth.js";
export * from "./browser-device-auth.js";
export * from "./gateway-origin-scope.js";
export * from "./connect-auth.js";
export * from "./protocol-client.js";
export * from "./reconnect-policy.js";
export * from "./session-projection.js";
export * from "./session-subscriptions.js";
// Keep these values local: cross-entry re-exports from `timeouts` produce
// missing bindings in the current tsdown multi-entry output.
export const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15_000;
export function resolveSafeTimeoutDelayMs(delayMs: number, options?: { minMs?: number }): number {
  const maxSafeDelayMs = 2_147_483_647;
  const rawMinMs = options?.minMs ?? 1;
  const minMs = Math.min(
    maxSafeDelayMs,
    Math.max(0, Number.isFinite(rawMinMs) ? Math.floor(rawMinMs) : 1),
  );
  const candidateMs = Number.isFinite(delayMs) ? Math.floor(delayMs) : minMs;
  return Math.min(maxSafeDelayMs, Math.max(minMs, candidateMs));
}
export * from "@openclaw/gateway-protocol/client-info";
export * from "@openclaw/gateway-protocol/connect-error-details";
export * from "@openclaw/gateway-protocol/gateway-error-details";
export * from "@openclaw/gateway-protocol/startup-unavailable";
export * from "@openclaw/gateway-protocol/version";
export type { ConnectParams, ErrorShape, EventFrame, HelloOk } from "@openclaw/gateway-protocol";
