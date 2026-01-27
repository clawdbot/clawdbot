import os from "node:os";

import { logDebug, logWarn } from "../logger.js";
import { getLogger } from "../logging.js";
import { ignoreCiaoCancellationRejection } from "./bonjour-ciao.js";
import { formatBonjourError } from "./bonjour-errors.js";
import { isTruthyEnvValue } from "./env.js";
import { registerUnhandledRejectionHandler } from "./unhandled-rejections.js";

export type GatewayBonjourAdvertiser = {
  stop: () => Promise<void>;
};

export type GatewayBonjourAdvertiseOpts = {
  instanceName?: string;
  gatewayPort: number;
  sshPort?: number;
  gatewayTlsEnabled?: boolean;
  gatewayTlsFingerprintSha256?: string;
  canvasPort?: number;
  tailnetDns?: string;
  cliPath?: string;
  /**
   * Minimal mode - omit sensitive fields (cliPath, sshPort) from TXT records.
   * Reduces information disclosure for better operational security.
   */
  minimal?: boolean;
};

function isDisabledByEnv() {
  if (isTruthyEnvValue(process.env.CLAWDBOT_DISABLE_BONJOUR)) return true;
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.VITEST) return true;
  return false;
}

function safeServiceName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "Moltbot";
}

function prettifyInstanceName(name: string) {
  const normalized = name.trim().replace(/\s+/g, " ");
  return normalized.replace(/\s+\(Moltbot\)\s*$/i, "").trim() || normalized;
}

type BonjourService = {
  advertise: () => Promise<void>;
  destroy: () => Promise<void>;
  getFQDN: () => string;
  getHostname: () => string;
  getPort: () => number;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  serviceState: string;
};

function serviceSummary(label: string, svc: BonjourService): string {
  let fqdn = "unknown";
  let hostname = "unknown";
  let port = -1;
  try {
    fqdn = svc.getFQDN();
  } catch {
    // ignore
  }
  try {
    hostname = svc.getHostname();
  } catch {
    // ignore
  }
  try {
    port = svc.getPort();
  } catch {
    // ignore
  }
  const state = typeof svc.serviceState === "string" ? svc.serviceState : "unknown";
  return `${label} fqdn=${fqdn} host=${hostname} port=${port} state=${state}`;
}

export async function startGatewayBonjourAdvertiser(
  opts: GatewayBonjourAdvertiseOpts,
): Promise<GatewayBonjourAdvertiser> {
  if (isDisabledByEnv()) {
    return { stop: async () => {} };
  }

  const { getResponder, Protocol } = await import("@homebridge/ciao");
  const responder = getResponder();

  // mDNS service instance names are single DNS labels; dots in hostnames (like
  // `Mac.localdomain`) can confuse some resolvers/browsers and break discovery.
  // Keep only the first label and normalize away a trailing `.local`.
  const hostname =
    os
      .hostname()
      .replace(/\.local$/i, "")
      .split(".")[0]
      .trim() || "moltbot";
  const instanceName =
    typeof opts.instanceName === "string" && opts.instanceName.trim()
      ? opts.instanceName.trim()
      : `${hostname} (Moltbot)`;
  const displayName = prettifyInstanceName(instanceName);

  const txtBase: Record<string, string> = {
    role: "gateway",
    gatewayPort: String(opts.gatewayPort),
    lanHost: `${hostname}.local`,
    displayName,
  };
  if (opts.gatewayTlsEnabled) {
    txtBase.gatewayTls = "1";
    if (opts.gatewayTlsFingerprintSha256) {
      txtBase.gatewayTlsSha256 = opts.gatewayTlsFingerprintSha256;
    }
  }
  if (typeof opts.canvasPort === "number" && opts.canvasPort > 0) {
    txtBase.canvasPort = String(opts.canvasPort);
  }
  if (typeof opts.tailnetDns === "string" && opts.tailnetDns.trim()) {
    txtBase.tailnetDns = opts.tailnetDns.trim();
  }
  // In minimal mode, omit cliPath to avoid exposing filesystem structure.
  // This info can be obtained via the authenticated WebSocket if needed.
  if (!opts.minimal && typeof opts.cliPath === "string" && opts.cliPath.trim()) {
    txtBase.cliPath = opts.cliPath.trim();
  }

  const services: Array<{ label: string; svc: BonjourService }> = [];

  // Build TXT record for the gateway service.
  // In minimal mode, omit sshPort to avoid advertising SSH availability.
  const gatewayTxt: Record<string, string> = {
    ...txtBase,
    transport: "gateway",
  };
  if (!opts.minimal) {
    gatewayTxt.sshPort = String(opts.sshPort ?? 22);
  }

  const gateway = responder.createService({
    name: safeServiceName(instanceName),
    type: "moltbot-gw",
    protocol: Protocol.TCP,
    port: opts.gatewayPort,
    domain: "local",
    hostname,
    txt: gatewayTxt,
  });
  services.push({
    label: "gateway",
    svc: gateway as unknown as BonjourService,
  });

  let ciaoCancellationRejectionHandler: (() => void) | undefined;
  if (services.length > 0) {
    ciaoCancellationRejectionHandler = registerUnhandledRejectionHandler(
      ignoreCiaoCancellationRejection,
    );
  }

  logDebug(
    `bonjour: starting (hostname=${hostname}, instance=${JSON.stringify(
      safeServiceName(instanceName),
    )}, gatewayPort=${opts.gatewayPort}${opts.minimal ? ", minimal=true" : `, sshPort=${opts.sshPort ?? 22}`})`,
  );

  for (const { label, svc } of services) {
    try {
      svc.on("name-change", (name: unknown) => {
        const next = typeof name === "string" ? name : String(name);
        logWarn(`bonjour: ${label} name conflict resolved; newName=${JSON.stringify(next)}`);
      });
      svc.on("hostname-change", (nextHostname: unknown) => {
        const next = typeof nextHostname === "string" ? nextHostname : String(nextHostname);
        logWarn(
          `bonjour: ${label} hostname conflict resolved; newHostname=${JSON.stringify(next)}`,
        );
      });
    } catch (err) {
      logDebug(`bonjour: failed to attach listeners for ${label}: ${String(err)}`);
    }
  }

  // Do not block gateway startup on mDNS probing/announce. Advertising can take
  // multiple seconds depending on network state; the gateway should come up even
  // if Bonjour is slow or fails.
  for (const { label, svc } of services) {
    try {
      void svc
        .advertise()
        .then(() => {
          // Keep this out of stdout/stderr (menubar + tests) but capture in the rolling log.
          getLogger().info(`bonjour: advertised ${serviceSummary(label, svc)}`);
        })
        .catch((err) => {
          logWarn(
            `bonjour: advertise failed (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`,
          );
        });
    } catch (err) {
      logWarn(
        `bonjour: advertise threw (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`,
      );
    }
  }

  // Watchdog: if we ever end up in an unannounced state (e.g. after sleep/wake or
  // interface churn), try to re-advertise instead of requiring a full gateway restart.
  const lastRepairAttempt = new Map<string, number>();
  const watchdog = setInterval(() => {
    for (const { label, svc } of services) {
      const stateUnknown = (svc as { serviceState?: unknown }).serviceState;
      if (typeof stateUnknown !== "string") continue;
      if (stateUnknown === "announced" || stateUnknown === "announcing") continue;

      let key = label;
      try {
        key = `${label}:${svc.getFQDN()}`;
      } catch {
        // ignore
      }
      const now = Date.now();
      const last = lastRepairAttempt.get(key) ?? 0;
      if (now - last < 30_000) continue;
      lastRepairAttempt.set(key, now);

      logWarn(
        `bonjour: watchdog detected non-announced service; attempting re-advertise (${serviceSummary(
          label,
          svc,
        )})`,
      );
      try {
        void svc.advertise().catch((err) => {
          logWarn(
            `bonjour: watchdog advertise failed (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`,
          );
        });
      } catch (err) {
        logWarn(
          `bonjour: watchdog advertise threw (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`,
        );
      }
    }
  }, 60_000);
  watchdog.unref?.();

  return {
    stop: async () => {
      clearInterval(watchdog);
      for (const { svc } of services) {
        try {
          await svc.destroy();
        } catch {
          /* ignore */
        }
      }
      try {
        await responder.shutdown();
      } catch {
        /* ignore */
      } finally {
        ciaoCancellationRejectionHandler?.();
      }
    },
  };
}
