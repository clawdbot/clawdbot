/** Gateway health auth diagnostic helpers for reachable-but-unauthenticated probes. */
import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";

type GatewayProbeReachabilityEvidence = NonNullable<DaemonStatus["rpc"]>;

export const GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE =
  "Gateway is reachable, but this CLI has no token/password or paired device token for read-scope health RPCs.";
export const GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE = "Gateway credentials required";
export const GATEWAY_HEALTH_REACHABLE_LINE = "Gateway: reachable";

/**
 * Detects when a daemon probe reached the gateway even if read-scope auth failed.
 */
export function gatewayProbeResultSawGateway(status: GatewayProbeReachabilityEvidence): boolean {
  if (status.ok) {
    return true;
  }
  const auth = status.auth;
  if (auth?.capability && auth.capability !== "unknown") {
    return true;
  }
  if (auth?.role || (auth?.scopes?.length ?? 0) > 0) {
    return true;
  }
  const server = status.server;
  if (server?.version || server?.connId) {
    return true;
  }
  // Older probes may only expose close/error text for auth failures; treat known gateway
  // close reasons as reachability evidence so health can explain missing credentials.
  return /\bgateway closed \(\d+\):|\bpairing required\b|\bdevice identity required\b/i.test(
    status.error ?? "",
  );
}

/**
 * Builds the health diagnostic emitted when the gateway is reachable but credentials are absent.
 */
export function buildCredentialsRequiredHealthDiagnostic() {
  return {
    ok: false,
    error: {
      type: "gateway_credentials_required",
      message: GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
    },
    gateway: {
      reachable: true,
    },
  };
}
