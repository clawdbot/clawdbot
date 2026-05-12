import { isTruthyEnvValue } from "../infra/env.js";
import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";
import { resolveWideAreaDiscoveryDomain, writeWideAreaGatewayZone } from "../infra/widearea-dns.js";
import type { PluginGatewayDiscoveryServiceRegistration } from "../plugins/registry-types.js";
import {
  formatBonjourInstanceName,
  resolveBonjourCliPath,
  resolveTailnetDnsHint,
} from "./server-discovery.js";

const DEFAULT_DISCOVERY_ADVERTISE_TIMEOUT_MS = 5_000;

function resolveDiscoveryAdvertiseTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_DISCOVERY_ADVERTISE_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DISCOVERY_ADVERTISE_TIMEOUT_MS;
  }
  return parsed;
}

export async function startGatewayDiscovery(params: {
  machineDisplayName: string;
  port: number;
  gatewayTls?: { enabled: boolean; fingerprintSha256?: string };
  canvasPort?: number;
  wideAreaDiscoveryEnabled: boolean;
  wideAreaDiscoveryDomain?: string | null;
  tailscaleMode: "off" | "serve" | "funnel";
  /** mDNS/Bonjour discovery mode (default: minimal). */
  mdnsMode?: "off" | "minimal" | "full";
  gatewayDiscoveryServices?: readonly PluginGatewayDiscoveryServiceRegistration[];
  logDiscovery: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  let bonjourStop: (() => Promise<void>) | null = null;
  const mdnsMode = params.mdnsMode ?? "minimal";
  // Local discovery can be disabled via config (mdnsMode: off) or env var.
  const localDiscoveryEnabled =
    mdnsMode !== "off" &&
    !isTruthyEnvValue(process.env.OPENCLAW_DISABLE_BONJOUR) &&
    process.env.NODE_ENV !== "test" &&
    !process.env.VITEST;
  const mdnsMinimal = mdnsMode !== "full";
  const tailscaleEnabled = params.tailscaleMode !== "off";
  const needsTailnetDns = localDiscoveryEnabled || params.wideAreaDiscoveryEnabled;
  const advertiseTimeoutMs = resolveDiscoveryAdvertiseTimeoutMs(process.env);
  const tailnetDns = needsTailnetDns
    ? await resolveTailnetDnsHint({ enabled: tailscaleEnabled })
    : undefined;
  const sshPortEnv = mdnsMinimal ? undefined : process.env.OPENCLAW_SSH_PORT?.trim();
  const sshPortParsed = sshPortEnv ? Number.parseInt(sshPortEnv, 10) : Number.NaN;
  const sshPort = Number.isFinite(sshPortParsed) && sshPortParsed > 0 ? sshPortParsed : undefined;
  const cliPath = mdnsMinimal ? undefined : resolveBonjourCliPath();

  if (localDiscoveryEnabled) {
    const stops: Array<() => void | Promise<void>> = [];
    let attemptedLocalDiscovery = false;
    let stoppedLocalDiscovery = false;
    for (const entry of params.gatewayDiscoveryServices ?? []) {
      attemptedLocalDiscovery = true;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const context = {
          machineDisplayName: params.machineDisplayName,
          gatewayPort: params.port,
          gatewayTlsEnabled: params.gatewayTls?.enabled ?? false,
          gatewayTlsFingerprintSha256: params.gatewayTls?.fingerprintSha256,
          canvasPort: params.canvasPort,
          sshPort,
          tailnetDns,
          cliPath,
          minimal: mdnsMinimal,
        };
        const advertisePromise = Promise.resolve()
          .then(() => entry.service.advertise(context))
          .then(
            async (started) => {
              if (timedOut) {
                if (started?.stop) {
                  if (stoppedLocalDiscovery) {
                    try {
                      await started.stop();
                    } catch (err) {
                      params.logDiscovery.warn(`gateway discovery stop failed: ${String(err)}`);
                    }
                  } else {
                    stops.push(started.stop);
                  }
                }
                params.logDiscovery.warn(
                  `gateway discovery service completed after startup timeout (${entry.service.id}, plugin=${entry.pluginId})`,
                );
              }
              return started;
            },
            (err) => {
              params.logDiscovery.warn(
                `gateway discovery service failed${timedOut ? " after startup timeout" : ""} (${entry.service.id}, plugin=${entry.pluginId}): ${String(err)}`,
              );
              return undefined;
            },
          );
        const timeoutPromise = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            params.logDiscovery.warn(
              `gateway discovery service timed out after ${advertiseTimeoutMs}ms (${entry.service.id}, plugin=${entry.pluginId}); continuing startup`,
            );
            resolve(undefined);
          }, advertiseTimeoutMs);
          timer.unref?.();
        });
        const started = await Promise.race([advertisePromise, timeoutPromise]);
        if (timer) {
          clearTimeout(timer);
        }
        if (started?.stop) {
          stops.push(started.stop);
        }
      } catch (err) {
        params.logDiscovery.warn(
          `gateway discovery service failed (${entry.service.id}, plugin=${entry.pluginId}): ${String(err)}`,
        );
      }
    }
    if (attemptedLocalDiscovery) {
      bonjourStop = async () => {
        stoppedLocalDiscovery = true;
        for (const stop of stops.toReversed()) {
          try {
            await stop();
          } catch (err) {
            params.logDiscovery.warn(`gateway discovery stop failed: ${String(err)}`);
          }
        }
      };
    }
  }

  if (params.wideAreaDiscoveryEnabled) {
    const wideAreaDomain = resolveWideAreaDiscoveryDomain({
      configDomain: params.wideAreaDiscoveryDomain ?? undefined,
    });
    if (!wideAreaDomain) {
      params.logDiscovery.warn(
        "discovery.wideArea.enabled is true, but no domain was configured; set discovery.wideArea.domain to enable unicast DNS-SD",
      );
      return { bonjourStop };
    }
    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    if (!tailnetIPv4) {
      params.logDiscovery.warn(
        "discovery.wideArea.enabled is true, but no Tailscale IPv4 address was found; skipping unicast DNS-SD zone update",
      );
    } else {
      try {
        const tailnetIPv6 = pickPrimaryTailnetIPv6();
        const result = await writeWideAreaGatewayZone({
          domain: wideAreaDomain,
          gatewayPort: params.port,
          displayName: formatBonjourInstanceName(params.machineDisplayName),
          tailnetIPv4,
          tailnetIPv6: tailnetIPv6 ?? undefined,
          gatewayTlsEnabled: params.gatewayTls?.enabled ?? false,
          gatewayTlsFingerprintSha256: params.gatewayTls?.fingerprintSha256,
          tailnetDns,
          sshPort,
          cliPath,
        });
        params.logDiscovery.info(
          `wide-area DNS-SD ${result.changed ? "updated" : "unchanged"} (${wideAreaDomain} → ${result.zonePath})`,
        );
      } catch (err) {
        params.logDiscovery.warn(`wide-area discovery update failed: ${String(err)}`);
      }
    }
  }

  return { bonjourStop };
}
