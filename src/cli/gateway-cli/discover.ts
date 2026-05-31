import { colorize, theme } from "../../../packages/terminal-core/src/theme.js";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import { buildGatewayDiscoveryTarget } from "../../infra/gateway-discovery-targets.js";
import { parseTimeoutMsWithFallback } from "../parse-timeout.js";

export type GatewayDiscoverOpts = {
  timeout?: string;
  json?: boolean;
};

export function parseDiscoverTimeoutMs(raw: unknown, fallbackMs: number): number {
  return parseTimeoutMsWithFallback(raw, fallbackMs, { invalidType: "error" });
}

export function pickBeaconHost(beacon: GatewayBonjourBeacon): string | null {
  return buildGatewayDiscoveryTarget(beacon).endpoint?.host ?? null;
}

export function pickGatewayPort(beacon: GatewayBonjourBeacon): number | null {
  return buildGatewayDiscoveryTarget(beacon).endpoint?.port ?? null;
}

export function dedupeBeacons(beacons: GatewayBonjourBeacon[]): GatewayBonjourBeacon[] {
  const out: GatewayBonjourBeacon[] = [];
  const seen = new Set<string>();
  for (const b of beacons) {
    const host = pickBeaconHost(b) ?? "";
    const key = [
      b.domain ?? "",
      b.instanceName ?? "",
      b.displayName ?? "",
      host,
      String(b.port ?? ""),
      String(b.gatewayPort ?? ""),
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(b);
  }
  return out;
}

export function renderBeaconLines(beacon: GatewayBonjourBeacon, rich: boolean): string[] {
  const target = buildGatewayDiscoveryTarget(beacon);
  const title = colorize(rich, theme.accentBright, target.title);
  const domain = colorize(rich, theme.muted, target.domain);

  const lines = [`- ${title} ${domain}`];

  if (beacon.tailnetDns) {
    lines.push(`  ${colorize(rich, theme.info, "tailnet")}: ${beacon.tailnetDns}`);
  }
  if (beacon.lanHost) {
    lines.push(`  ${colorize(rich, theme.info, "lan")}: ${beacon.lanHost}`);
  }
  if (beacon.host) {
    lines.push(`  ${colorize(rich, theme.info, "host")}: ${beacon.host}`);
  }

  if (target.wsUrl) {
    lines.push(
      `  ${colorize(rich, theme.muted, "ws")}: ${colorize(rich, theme.command, target.wsUrl)}`,
    );
  }
  if (beacon.role) {
    lines.push(`  ${colorize(rich, theme.muted, "role")}: ${beacon.role}`);
  }
  if (beacon.transport) {
    lines.push(`  ${colorize(rich, theme.muted, "transport")}: ${beacon.transport}`);
  }
  if (beacon.gatewayTls) {
    const fingerprint = beacon.gatewayTlsFingerprintSha256
      ? `sha256 ${beacon.gatewayTlsFingerprintSha256}`
      : "enabled";
    lines.push(`  ${colorize(rich, theme.muted, "tls")}: ${fingerprint}`);
  }
  if (target.endpoint && target.sshPort) {
    const ssh = `ssh -N -L 18789:127.0.0.1:18789 <user>@${target.endpoint.host} -p ${target.sshPort}`;
    lines.push(`  ${colorize(rich, theme.muted, "ssh")}: ${colorize(rich, theme.command, ssh)}`);
  }
  return lines;
}
