import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";

type GatewayProbeReachabilityEvidence = NonNullable<DaemonStatus["rpc"]>;

export const GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE =
  "Gateway is reachable, but this CLI has no token/password or paired device token for read-scope health RPCs.";
export const GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE = "Gateway credentials required";
export const GATEWAY_HEALTH_REACHABLE_LINE = "Gateway: reachable";

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
  return /\bgateway closed \(\d+\):|\bpairing required\b|\bdevice identity required\b/i.test(
    status.error ?? "",
  );
}

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
