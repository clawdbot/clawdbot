// Gateway control-plane audit helpers.
// Extracts stable actor identity and compact changed-path summaries for audit logs.
import { normalizeControlPlaneIdentityPart } from "./control-plane-identity.js";
import type { GatewayClient } from "./server-methods/types.js";

/** Stable actor fields included in control-plane audit and rate-limit logs. */
export type ControlPlaneActor = {
  actor: string;
  deviceId: string;
  clientIp: string;
  connId: string;
};

/** Extracts audit identity from a possibly missing or partially connected client. */
export function resolveControlPlaneActor(client: GatewayClient | null): ControlPlaneActor {
  return {
    actor: normalizeControlPlaneIdentityPart(client?.connect?.client?.id, "unknown-actor"),
    deviceId: normalizeControlPlaneIdentityPart(client?.connect?.device?.id, "unknown-device"),
    clientIp: normalizeControlPlaneIdentityPart(client?.clientIp, "unknown-ip"),
    connId: normalizeControlPlaneIdentityPart(client?.connId, "unknown-conn"),
  };
}

/** Formats actor identity as compact key/value text for structured gateway logs. */
export function formatControlPlaneActor(actor: ControlPlaneActor): string {
  return `actor=${actor.actor} device=${actor.deviceId} ip=${actor.clientIp} conn=${actor.connId}`;
}

/** Summarizes changed config/state paths without letting audit logs grow unbounded. */
export function summarizeChangedPaths(paths: string[], maxPaths = 8): string {
  if (paths.length === 0) {
    return "<none>";
  }
  if (paths.length <= maxPaths) {
    return paths.join(",");
  }
  const head = paths.slice(0, maxPaths).join(",");
  return `${head},+${paths.length - maxPaths} more`;
}
