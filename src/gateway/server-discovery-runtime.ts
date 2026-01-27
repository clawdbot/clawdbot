import { startGatewayBonjourAdvertiser } from "../infra/bonjour.js";
import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";
import { WIDE_AREA_DISCOVERY_DOMAIN, writeWideAreaGatewayZone } from "../infra/widearea-dns.js";
import {
  formatBonjourInstanceName,
  resolveBonjourCliPath,
  resolveTailnetDnsHint,
} from "./server-discovery.js";

export async function startGatewayDiscovery(params: {
  machineDisplayName: string;
  port: number;
  gatewayTls?: { enabled: boolean; fingerprintSha256?: string };
  canvasPort?: number;
  wideAreaDiscoveryEnabled: boolean;
  tailscaleMode: "off" | "serve" | "funnel";
  /** mDNS/Bonjour discovery mode (default: minimal). */
  mdnsMode?: "off" | "minimal" | "full";
  logDiscovery: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  let bonjourStop: (() => Promise<void>) | null = null;
  const mdnsMode = params.mdnsMode ?? "minimal";
  // mDNS can be disabled via config (mdnsMode: off) or env var.
  const bonjourEnabled =
    mdnsMode !== "off" &&
    process.env.CLAWDBOT_DISABLE_BONJOUR !== "1" &&
    process.env.NODE_ENV !== "test" &&
    !process.env.VITEST;
  const mdnsMinimal = mdnsMode !== "full";
  const tailscaleEnabled = params.tailscaleMode !== "off";
  const needsTailnetDns = bonjourEnabled || params.wideAreaDiscoveryEnabled;
  const tailnetDns = needsTailnetDns
    ? await resolveTailnetDnsHint({ enabled: tailscaleEnabled })
    : undefined;
  const sshPortEnv = mdnsMinimal ? undefined : process.env.CLAWDBOT_SSH_PORT?.trim();
  const sshPortParsed = sshPortEnv ? Number.parseInt(sshPortEnv, 10) : NaN;
  const sshPort = Number.isFinite(sshPortParsed) && sshPortParsed > 0 ? sshPortParsed : undefined;
  const cliPath = mdnsMinimal ? undefined : resolveBonjourCliPath();

  if (bonjourEnabled) {
    try {
      const bonjour = await startGatewayBonjourAdvertiser({
        instanceName: formatBonjourInstanceName(params.machineDisplayName),
        gatewayPort: params.port,
        gatewayTlsEnabled: params.gatewayTls?.enabled ?? false,
        gatewayTlsFingerprintSha256: params.gatewayTls?.fingerprintSha256,
        canvasPort: params.canvasPort,
        sshPort,
        tailnetDns,
        cliPath,
        minimal: mdnsMinimal,
      });
      bonjourStop = bonjour.stop;
    } catch (err) {
      params.logDiscovery.warn(`bonjour advertising failed: ${String(err)}`);
    }
  }

  if (params.wideAreaDiscoveryEnabled) {
    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    if (!tailnetIPv4) {
      params.logDiscovery.warn(
        "discovery.wideArea.enabled is true, but no Tailscale IPv4 address was found; skipping unicast DNS-SD zone update",
      );
    } else {
      try {
        const tailnetIPv6 = pickPrimaryTailnetIPv6();
        const result = await writeWideAreaGatewayZone({
          gatewayPort: params.port,
          displayName: formatBonjourInstanceName(params.machineDisplayName),
          tailnetIPv4,
          tailnetIPv6: tailnetIPv6 ?? undefined,
          gatewayTlsEnabled: params.gatewayTls?.enabled ?? false,
          gatewayTlsFingerprintSha256: params.gatewayTls?.fingerprintSha256,
          tailnetDns,
          sshPort,
          cliPath: resolveBonjourCliPath(),
        });
        params.logDiscovery.info(
          `wide-area DNS-SD ${result.changed ? "updated" : "unchanged"} (${WIDE_AREA_DISCOVERY_DOMAIN} → ${result.zonePath})`,
        );
      } catch (err) {
        params.logDiscovery.warn(`wide-area discovery update failed: ${String(err)}`);
      }
    }
  }

  return { bonjourStop };
}
