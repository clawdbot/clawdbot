import { logDebug, logWarn } from "../logger.js";
import { getLogger } from "../logging.js";
import { classifyCiaoUnhandledRejection } from "./bonjour-ciao.js";
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
  if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_BONJOUR)) {
    return true;
  }
  if (process.env.NODE_ENV === "test") {
    return true;
  }
  if (process.env.VITEST) {
    return true;
  }
  return false;
}

function safeServiceName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "OpenClaw";
}

function prettifyInstanceName(name: string) {
  const normalized = name.trim().replace(/\s+/g, " ");
  return normalized.replace(/\s+\(OpenClaw\)\s*$/i, "").trim() || normalized;
}

type BonjourService = import("@homebridge/ciao").CiaoService;
type BonjourResponder = import("@homebridge/ciao").Responder;
type BonjourServiceState = BonjourService["serviceState"];

type BonjourCycle = {
  responder: BonjourResponder;
  services: Array<{ label: string; svc: BonjourService }>;
  cleanupUnhandledRejection?: () => void;
};

type ServiceStateTracker = {
  state: BonjourServiceState | "unknown";
  sinceMs: number;
};

type ConsoleLogFn = (...args: unknown[]) => void;

const WATCHDOG_INTERVAL_MS = 5_000;
const REPAIR_DEBOUNCE_MS = 30_000;
const STUCK_ANNOUNCING_MS = 8_000;
const BONJOUR_ANNOUNCED_STATE = "announced" as BonjourServiceState;
const CIAO_SELF_PROBE_RETRY_FRAGMENT =
  "failed probing with reason: Error: Can't probe for a service which is announced already.";

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

function isAnnouncedState(state: BonjourServiceState | "unknown") {
  return state === BONJOUR_ANNOUNCED_STATE;
}

function handleCiaoUnhandledRejection(reason: unknown): boolean {
  const classification = classifyCiaoUnhandledRejection(reason);
  if (!classification) {
    return false;
  }

  if (classification.kind === "interface-assertion") {
    logWarn(`bonjour: suppressing ciao interface assertion: ${classification.formatted}`);
    return true;
  }

  logDebug(`bonjour: ignoring unhandled ciao rejection: ${classification.formatted}`);
  return true;
}

function shouldSuppressCiaoConsoleLog(args: unknown[]): boolean {
  return args.some(
    (arg) => typeof arg === "string" && arg.includes(CIAO_SELF_PROBE_RETRY_FRAGMENT),
  );
}

function installCiaoConsoleNoiseFilter(): () => void {
  const originalConsoleLog = console.log as ConsoleLogFn;
  console.log = ((...args: unknown[]) => {
    if (shouldSuppressCiaoConsoleLog(args)) {
      return;
    }
    originalConsoleLog(...args);
  }) as ConsoleLogFn;
  return () => {
    if (console.log === originalConsoleLog) {
      return;
    }
    console.log = originalConsoleLog;
  };
}

export async function startGatewayBonjourAdvertiser(
  opts: GatewayBonjourAdvertiseOpts,
): Promise<GatewayBonjourAdvertiser> {
  if (isDisabledByEnv()) {
    return { stop: async () => {} };
  }

  const { getResponder, Protocol } = await import("@homebridge/ciao");
  const restoreConsoleLog = installCiaoConsoleNoiseFilter();
  try {
    // mDNS service instance names are single DNS labels; dots in hostnames (like
    // `Mac.localdomain`) can confuse some resolvers/browsers and break discovery.
    // Keep only the first label and normalize away a trailing `.local`.
    const hostnameRaw = process.env.OPENCLAW_MDNS_HOSTNAME?.trim() || "openclaw";
    const hostname =
      hostnameRaw
        .replace(/\.local$/i, "")
        .split(".")[0]
        .trim() || "openclaw";
    const instanceName =
      typeof opts.instanceName === "string" && opts.instanceName.trim()
        ? opts.instanceName.trim()
        : `${hostname} (OpenClaw)`;
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

    // Build TXT record for the gateway service.
    // In minimal mode, omit sshPort to avoid advertising SSH availability.
    const gatewayTxt: Record<string, string> = {
      ...txtBase,
      transport: "gateway",
    };
    if (!opts.minimal) {
      gatewayTxt.sshPort = String(opts.sshPort ?? 22);
    }

    function createCycle(): BonjourCycle {
      const responder = getResponder();
      const services: Array<{ label: string; svc: BonjourService }> = [];

      const gateway = responder.createService({
        name: safeServiceName(instanceName),
        type: "openclaw-gw",
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

      const cleanupUnhandledRejection =
        services.length > 0
          ? registerUnhandledRejectionHandler(handleCiaoUnhandledRejection)
          : undefined;

      return { responder, services, cleanupUnhandledRejection };
    }

    async function stopCycle(cycle: BonjourCycle | null) {
      if (!cycle) {
        return;
      }
      const responder = cycle.responder as unknown as {
        advertiseService?: (...args: unknown[]) => unknown;
        announce?: (...args: unknown[]) => unknown;
        probe?: (...args: unknown[]) => unknown;
        republishService?: (...args: unknown[]) => unknown;
      };
      const noopAsync = async () => {};
      // ciao schedules its own 2s retry timers after failed probe/announce attempts.
      // Those callbacks target the original responder instance, so disarm it before
      // destroy/shutdown to prevent a dead cycle from re-entering advertise/probe.
      responder.advertiseService = noopAsync;
      responder.announce = noopAsync;
      responder.probe = noopAsync;
      responder.republishService = noopAsync;
      for (const { svc } of cycle.services) {
        try {
          await svc.destroy();
        } catch {
          /* ignore */
        }
      }
      try {
        await cycle.responder.shutdown();
      } catch {
        /* ignore */
      } finally {
        cycle.cleanupUnhandledRejection?.();
      }
    }

    function attachConflictListeners(services: Array<{ label: string; svc: BonjourService }>) {
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
    }

    function startAdvertising(services: Array<{ label: string; svc: BonjourService }>) {
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
    }

    logDebug(
      `bonjour: starting (hostname=${hostname}, instance=${JSON.stringify(
        safeServiceName(instanceName),
      )}, gatewayPort=${opts.gatewayPort}${opts.minimal ? ", minimal=true" : `, sshPort=${opts.sshPort ?? 22}`})`,
    );

    let stopped = false;
    let recreatePromise: Promise<void> | null = null;
    let cycle = createCycle();
    const stateTracker = new Map<string, ServiceStateTracker>();
    attachConflictListeners(cycle.services);
    startAdvertising(cycle.services);

    const updateStateTrackers = (services: Array<{ label: string; svc: BonjourService }>) => {
      const now = Date.now();
      for (const { label, svc } of services) {
        const nextState: BonjourServiceState | "unknown" =
          typeof svc.serviceState === "string" ? svc.serviceState : "unknown";
        const current = stateTracker.get(label);
        const nextEnteredAt =
          current && !isAnnouncedState(current.state) && !isAnnouncedState(nextState)
            ? current.sinceMs
            : now;
        if (!current || current.state !== nextState || current.sinceMs !== nextEnteredAt) {
          stateTracker.set(label, { state: nextState, sinceMs: nextEnteredAt });
        }
      }
    };

    const recreateAdvertiser = async (reason: string) => {
      if (stopped) {
        return;
      }
      if (recreatePromise) {
        return recreatePromise;
      }
      recreatePromise = (async () => {
        logWarn(`bonjour: restarting advertiser (${reason})`);
        const previous = cycle;
        await stopCycle(previous);
        cycle = createCycle();
        stateTracker.clear();
        attachConflictListeners(cycle.services);
        startAdvertising(cycle.services);
      })().finally(() => {
        recreatePromise = null;
      });
      return recreatePromise;
    };

    // Watchdog: if we ever end up in an unannounced state (e.g. after sleep/wake or
    // interface churn), try to re-advertise instead of requiring a full gateway restart.
    const lastRepairAttempt = new Map<string, number>();
    const watchdog = setInterval(() => {
      if (stopped || recreatePromise) {
        return;
      }
      updateStateTrackers(cycle.services);
      for (const { label, svc } of cycle.services) {
        const stateUnknown = (svc as { serviceState?: unknown }).serviceState;
        if (typeof stateUnknown !== "string") {
          continue;
        }
        const tracked = stateTracker.get(label);
        if (
          stateUnknown !== "announced" &&
          tracked &&
          Date.now() - tracked.sinceMs >= STUCK_ANNOUNCING_MS
        ) {
          void recreateAdvertiser(
            `service stuck in ${stateUnknown} for ${Date.now() - tracked.sinceMs}ms (${serviceSummary(
              label,
              svc,
            )})`,
          );
          return;
        }
        if (stateUnknown === "announced" || stateUnknown === "announcing") {
          continue;
        }

        let key = label;
        try {
          key = `${label}:${svc.getFQDN()}`;
        } catch {
          // ignore
        }
        const now = Date.now();
        const last = lastRepairAttempt.get(key) ?? 0;
        if (now - last < REPAIR_DEBOUNCE_MS) {
          continue;
        }
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
    }, WATCHDOG_INTERVAL_MS);
    watchdog.unref?.();

    return {
      stop: async () => {
        stopped = true;
        try {
          clearInterval(watchdog);
          await recreatePromise;
          await stopCycle(cycle);
        } finally {
          restoreConsoleLog();
        }
      },
    };
  } catch (err) {
    restoreConsoleLog();
    throw err;
  }
}
