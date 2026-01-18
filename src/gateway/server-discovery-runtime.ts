import { startGatewayBonjourAdvertiser } from "../infra/bonjour.js";
import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";
import { WIDE_AREA_DISCOVERY_DOMAIN, writeWideAreaBridgeZone } from "../infra/widearea-dns.js";
import {
  formatBonjourInstanceName,
  resolveBonjourCliPath,
  resolveTailnetDnsHint,
} from "./server-discovery.js";

export async function startGatewayDiscovery(params: {
  machineDisplayName: string;
  port: number;
  bridgePort?: number;
  bridgeTls?: { enabled: boolean; fingerprintSha256?: string };
  canvasPort?: number;
  wideAreaDiscoveryEnabled: boolean;
  logDiscovery: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  let bonjourStop: (() => Promise<void>) | null = null;
  const bonjourEnabled =
    process.env.CLAWDBOT_DISABLE_BONJOUR !== "1" &&
    process.env.NODE_ENV !== "test" &&
    !process.env.VITEST;
  const needsTailnetDns = bonjourEnabled || params.wideAreaDiscoveryEnabled;
  const tailnetDns = needsTailnetDns ? await resolveTailnetDnsHint() : undefined;
  const sshPortEnv = process.env.CLAWDBOT_SSH_PORT?.trim();
  const sshPortParsed = sshPortEnv ? Number.parseInt(sshPortEnv, 10) : NaN;
  const sshPort = Number.isFinite(sshPortParsed) && sshPortParsed > 0 ? sshPortParsed : undefined;

  try {
    const bonjour = await startGatewayBonjourAdvertiser({
      instanceName: formatBonjourInstanceName(params.machineDisplayName),
      gatewayPort: params.port,
      bridgePort: params.bridgePort,
      canvasPort: params.canvasPort,
      bridgeTlsEnabled: params.bridgeTls?.enabled ?? false,
      bridgeTlsFingerprintSha256: params.bridgeTls?.fingerprintSha256,
      sshPort,
      tailnetDns,
      cliPath: resolveBonjourCliPath(),
    });
    bonjourStop = bonjour.stop;
  } catch (err) {
    params.logDiscovery.warn(`bonjour advertising failed: ${String(err)}`);
  }

  if (params.wideAreaDiscoveryEnabled && params.bridgePort) {
    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    if (!tailnetIPv4) {
      params.logDiscovery.warn(
        "discovery.wideArea.enabled is true, but no Tailscale IPv4 address was found; skipping unicast DNS-SD zone update",
      );
    } else {
      try {
        const tailnetIPv6 = pickPrimaryTailnetIPv6();
        const result = await writeWideAreaBridgeZone({
          bridgePort: params.bridgePort,
          gatewayPort: params.port,
          displayName: formatBonjourInstanceName(params.machineDisplayName),
          tailnetIPv4,
          tailnetIPv6: tailnetIPv6 ?? undefined,
          bridgeTlsEnabled: params.bridgeTls?.enabled ?? false,
          bridgeTlsFingerprintSha256: params.bridgeTls?.fingerprintSha256,
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
