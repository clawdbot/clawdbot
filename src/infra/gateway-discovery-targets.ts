// Normalizes gateway discovery targets for local and remote lookups.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveGatewayDiscoveryEndpoint,
  type GatewayBonjourBeacon,
  type GatewayDiscoveryResolvedEndpoint,
} from "./bonjour-discovery.js";

// Gateway discovery targets turn Bonjour beacons into display, websocket, and
// SSH connection hints without assuming every beacon has all fields.
type GatewayDiscoveryTarget = {
  title: string;
  domain: string;
  endpoint: GatewayDiscoveryResolvedEndpoint | null;
  wsUrl: string | null;
  sshPort: number | null;
  sshTarget: string | null;
};

function pickSshPort(beacon: GatewayBonjourBeacon): number | null {
  return typeof beacon.sshPort === "number" && Number.isFinite(beacon.sshPort) && beacon.sshPort > 0
    ? beacon.sshPort
    : null;
}

/** Build normalized connection details for a discovered gateway beacon. */
export function buildGatewayDiscoveryTarget(
  beacon: GatewayBonjourBeacon,
  opts?: { sshUser?: string | null },
): GatewayDiscoveryTarget {
  const endpoint = resolveGatewayDiscoveryEndpoint(beacon);
  const sshPort = pickSshPort(beacon);
  const sshUser = normalizeOptionalString(opts?.sshUser) ?? "";
  const baseSshTarget = endpoint ? (sshUser ? `${sshUser}@${endpoint.host}` : endpoint.host) : null;
  const sshTarget =
    baseSshTarget && sshPort && sshPort !== 22 ? `${baseSshTarget}:${sshPort}` : baseSshTarget;
  return {
    title:
      normalizeOptionalString(beacon.displayName || beacon.instanceName || "Gateway") ?? "Gateway",
    domain: normalizeOptionalString(beacon.domain || "local.") ?? "local.",
    endpoint,
    wsUrl: endpoint?.wsUrl ?? null,
    sshPort,
    sshTarget,
  };
}

/** Build the compact label shown in discovery lists. */
export function buildGatewayDiscoveryLabel(beacon: GatewayBonjourBeacon): string {
  const target = buildGatewayDiscoveryTarget(beacon);
  const hint = target.endpoint ? `${target.endpoint.host}:${target.endpoint.port}` : "host unknown";
  return `${target.title} (${hint})`;
}

/** Serialize a beacon with resolved websocket information for CLI/UI output. */
export function serializeGatewayDiscoveryBeacon(beacon: GatewayBonjourBeacon) {
  const target = buildGatewayDiscoveryTarget(beacon);
  return {
    instanceName: beacon.instanceName,
    displayName: beacon.displayName ?? null,
    domain: beacon.domain ?? null,
    host: beacon.host ?? null,
    lanHost: beacon.lanHost ?? null,
    tailnetDns: beacon.tailnetDns ?? null,
    gatewayPort: beacon.gatewayPort ?? null,
    sshPort: beacon.sshPort ?? null,
    wsUrl: target.wsUrl,
  };
}
