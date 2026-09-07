import {
  clampTimerTimeoutMs,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
import type { DiscoveryConfig, MdnsDiscoveryMode } from "../config/types.gateway.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";
import { parseTcpPort } from "../infra/tcp-port.js";
import { resolveWideAreaDiscoveryDomain, writeWideAreaGatewayZone } from "../infra/widearea-dns.js";
import type { PluginGatewayDiscoveryServiceRegistration } from "../plugins/registry-types.js";
import {
  formatBonjourInstanceName,
  resolveBonjourCliPath,
  resolveTailnetDnsHint,
} from "./server-discovery.js";
import type { GatewayPluginRuntimeClaim } from "./server-plugin-runtime-generation.js";

type DiscoveryUpdate = {
  mdnsMode?: MdnsDiscoveryMode;
  gatewayDiscoveryServices?: readonly PluginGatewayDiscoveryServiceRegistration[];
};
export type GatewayDiscovery = {
  update: (next: DiscoveryUpdate, claim?: GatewayPluginRuntimeClaim) => Promise<void>;
  stop: () => Promise<void>;
};
type DiscoveryGeneration = {
  mode: MdnsDiscoveryMode;
  services: Iterator<PluginGatewayDiscoveryServiceRegistration>;
  stops: Array<() => void | Promise<void>>;
  claim: GatewayPluginRuntimeClaim;
  waiting: boolean;
};

/** One owner replaces local advertisements and keeps wide-area TXT policy in sync. */
export async function startGatewayDiscovery(params: {
  discovery?: DiscoveryConfig;
  gatewayDiscoveryServices?: readonly PluginGatewayDiscoveryServiceRegistration[];
  pluginRuntimeClaim: GatewayPluginRuntimeClaim;
  machineDisplayName: string;
  port: number;
  gatewayTls?: { enabled: boolean; fingerprintSha256?: string };
  gatewayDirectReachable?: boolean;
  tailscaleMode: "off" | "serve" | "funnel";
  logDiscovery: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<GatewayDiscovery> {
  let mode = params.discovery?.mdns?.mode ?? "minimal";
  const wideAreaDomain = params.discovery?.wideArea?.domain;
  let services = params.gatewayDiscoveryServices ?? [];
  let claim = params.pluginRuntimeClaim;
  let current: DiscoveryGeneration | undefined;
  let closed = false;
  let pending = Promise.resolve();
  let cleanup = Promise.resolve();
  const isCurrent = (generation: DiscoveryGeneration) => !closed && current === generation;
  const stopService = (stop: () => void | Promise<void>) => {
    cleanup = cleanup.then(stop).catch((err: unknown) => {
      params.logDiscovery.warn(`gateway discovery stop failed: ${String(err)}`);
    });
    return cleanup;
  };
  const stopGeneration = async (generation?: DiscoveryGeneration) => {
    for (const stop of generation?.stops.splice(0).toReversed() ?? []) {
      void stopService(stop);
    }
    // Timed-out starts may acquire handles while another stop is awaiting I/O.
    // Drain those acquired callbacks too, without joining unresolved starts.
    let drained: Promise<void>;
    do {
      drained = cleanup;
      await drained;
    } while (drained !== cleanup);
  };
  const enqueue = (operation: () => Promise<void>) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const waitForClaim = (generation: DiscoveryGeneration) => {
    if (generation.waiting) {
      return;
    }
    generation.waiting = true;
    // A reservation may reject. Wait outside the operation queue: committing its
    // successor can itself await a mode update on this owner.
    void generation.claim
      .waitForUnblocked()
      .then((accepted) =>
        enqueue(async () => {
          generation.waiting = false;
          if (isCurrent(generation)) {
            await (accepted ? advertise(generation) : stopGeneration(generation));
          }
        }),
      )
      .catch((err: unknown) =>
        params.logDiscovery.warn(`gateway discovery refresh failed: ${String(err)}`),
      );
  };
  const advertise = async (generation: DiscoveryGeneration) => {
    if (!isCurrent(generation)) {
      return;
    }
    const localEnabled =
      generation.mode !== "off" &&
      !isTruthyEnvValue(process.env.OPENCLAW_DISABLE_BONJOUR) &&
      process.env.NODE_ENV !== "test" &&
      !process.env.VITEST;
    const minimal = generation.mode !== "full";
    const tailnetDns =
      localEnabled || wideAreaDomain?.trim()
        ? await resolveTailnetDnsHint({ enabled: params.tailscaleMode !== "off" })
        : undefined;
    if (!isCurrent(generation)) {
      return;
    }
    const context = {
      machineDisplayName: params.machineDisplayName,
      gatewayPort: params.port,
      gatewayTlsEnabled: params.gatewayTls?.enabled ?? false,
      gatewayTlsFingerprintSha256: params.gatewayTls?.fingerprintSha256,
      gatewayDirectReachable: params.gatewayDirectReachable === true,
      sshPort: minimal ? undefined : (parseTcpPort(process.env.OPENCLAW_SSH_PORT) ?? undefined),
      tailnetDns,
      cliPath: minimal ? undefined : resolveBonjourCliPath(),
      minimal,
    };
    if (wideAreaDomain?.trim()) {
      const domain = resolveWideAreaDiscoveryDomain({ configDomain: wideAreaDomain });
      const tailnetIPv4 = pickPrimaryTailnetIPv4();
      if (!domain) {
        params.logDiscovery.warn(
          "wide-area discovery was requested without a domain; set discovery.wideArea.domain to enable unicast DNS-SD",
        );
      } else if (!tailnetIPv4) {
        params.logDiscovery.warn(
          "discovery.wideArea.domain is set, but no Tailscale IPv4 address was found; skipping unicast DNS-SD zone update",
        );
      } else {
        try {
          const result = await writeWideAreaGatewayZone({
            ...context,
            domain,
            displayName: formatBonjourInstanceName(params.machineDisplayName),
            tailnetIPv4,
            tailnetIPv6: pickPrimaryTailnetIPv6() ?? undefined,
          });
          params.logDiscovery.info(
            `wide-area DNS-SD ${result.changed ? "updated" : "unchanged"} (${domain} → ${result.zonePath})`,
          );
        } catch (err) {
          params.logDiscovery.warn(`wide-area discovery update failed: ${String(err)}`);
        }
      }
    }
    const advertiseTimeoutMs =
      clampTimerTimeoutMs(
        parseStrictPositiveInteger(
          process.env.OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS?.trim(),
        ),
      ) ?? 5_000;
    for (;;) {
      const drained = cleanup;
      await drained;
      if (drained !== cleanup) {
        continue;
      }
      // Keep cleanup, ownership checks, and publication in one continuation.
      if (!localEnabled || !isCurrent(generation)) {
        return;
      }
      if (!generation.claim.isCurrent()) {
        waitForClaim(generation);
        return;
      }
      const next = generation.services.next();
      if (next.done) {
        return;
      }
      const entry = next.value;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = (async () => entry.service.advertise(context))()
        .then(async (handle) => {
          if (handle?.stop) {
            if (isCurrent(generation)) {
              generation.stops.push(handle.stop);
              if (!generation.claim.isCurrent()) {
                waitForClaim(generation);
              }
            } else {
              await stopService(handle.stop);
            }
          }
          if (timedOut) {
            params.logDiscovery.warn(
              `gateway discovery service completed after startup timeout (${entry.service.id}, plugin=${entry.pluginId})`,
            );
          }
        })
        .catch((err: unknown) => {
          params.logDiscovery.warn(
            `gateway discovery service failed${timedOut ? " after startup timeout" : ""} (${entry.service.id}, plugin=${entry.pluginId}): ${String(err)}`,
          );
        });
      await Promise.race([
        started,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            params.logDiscovery.warn(
              `gateway discovery service timed out after ${advertiseTimeoutMs}ms (${entry.service.id}, plugin=${entry.pluginId}); continuing startup`,
            );
            resolve();
          }, advertiseTimeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
  };
  const update: GatewayDiscovery["update"] = (next, nextClaim = claim) => {
    const nextMode = "mdnsMode" in next ? (next.mdnsMode ?? "minimal") : mode;
    const nextServices = next.gatewayDiscoveryServices ?? services;
    if (
      closed ||
      (current && mode === nextMode && services === nextServices && claim === nextClaim)
    ) {
      return Promise.resolve();
    }
    mode = nextMode;
    services = nextServices;
    claim = nextClaim;
    const previous = current;
    // Fence before awaiting cleanup so late startup cannot retain an obsolete beacon.
    const generation = (current = {
      mode,
      services: services.values(),
      stops: [],
      claim,
      waiting: false,
    });
    return enqueue(async () => {
      await stopGeneration(previous);
      await advertise(generation);
    });
  };
  await update({});
  return {
    update,
    stop: () => {
      closed = true;
      const previous = current;
      current = undefined;
      return enqueue(() => stopGeneration(previous));
    },
  };
}
