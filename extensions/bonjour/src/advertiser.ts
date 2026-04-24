import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";
import { classifyCiaoUnhandledRejection } from "./ciao.js";
import { formatBonjourError } from "./errors.js";

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
  minimal?: boolean;
};

type BonjourService = {
  serviceState?: unknown;
  advertise: () => Promise<void>;
  destroy: () => Promise<void>;
  getFQDN: () => string;
  getHostname: () => string;
  getPort: () => number;
  on: (event: "name-change" | "hostname-change", listener: (value: unknown) => void) => unknown;
};

type BonjourResponder = {
  createService: (options: {
    name: string;
    type: string;
    protocol: unknown;
    port: number;
    domain: string;
    hostname: string;
    txt: Record<string, string>;
  }) => BonjourService;
  shutdown: () => Promise<void>;
};

type CiaoModule = {
  getResponder: () => BonjourResponder;
  Protocol: { TCP: unknown };
};

type BonjourCycle = {
  responder: BonjourResponder;
  services: Array<{ label: string; svc: BonjourService }>;
  cleanupUnhandledRejection?: () => void;
};

type ServiceStateTracker = {
  state: string;
  sinceMs: number;
};

type ConsoleLogFn = (...args: unknown[]) => void;
type UnhandledRejectionHandler = (reason: unknown) => boolean;

type BonjourAdvertiserDeps = {
  logger?: Pick<PluginLogger, "info" | "warn" | "debug">;
  registerUnhandledRejectionHandler?: (handler: UnhandledRejectionHandler) => () => void;
};

const WATCHDOG_INTERVAL_MS = 5_000;
const REPAIR_DEBOUNCE_MS = 30_000;
const STUCK_ANNOUNCING_MS = 8_000;
const BONJOUR_ANNOUNCED_STATE = "announced";
const CIAO_SELF_PROBE_RETRY_FRAGMENT =
  "failed probing with reason: Error: Can't probe for a service which is announced already.";

const defaultLogger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
  debug: (_msg: string) => {},
};

const CIAO_MODULE_ID = "@homebridge/ciao";
let ciaoModulePromise: Promise<CiaoModule> | null = null;

async function loadCiaoModule(): Promise<CiaoModule> {
  ciaoModulePromise ??= import(CIAO_MODULE_ID) as Promise<CiaoModule>;
  return ciaoModulePromise;
}

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

function isAnnouncedState(state: string) {
  return state === BONJOUR_ANNOUNCED_STATE;
}

function shouldSuppressCiaoConsoleLog(args: unknown[]): boolean {
  return args.some(
    (arg) => typeof arg === "string" && arg.includes(CIAO_SELF_PROBE_RETRY_FRAGMENT),
  );
}

function installCiaoConsoleNoiseFilter(): () => void {
  const previousConsoleLog = console.log as ConsoleLogFn;
  const wrapper = ((...args: unknown[]) => {
    if (shouldSuppressCiaoConsoleLog(args)) {
      return;
    }
    previousConsoleLog(...args);
  }) as ConsoleLogFn;
  console.log = wrapper;
  return () => {
    if (console.log === wrapper) {
      console.log = previousConsoleLog;
    }
  };
}

export async function startGatewayBonjourAdvertiser(
  opts: GatewayBonjourAdvertiseOpts,
  deps: BonjourAdvertiserDeps = {},
): Promise<GatewayBonjourAdvertiser> {
  if (isDisabledByEnv()) {
    return { stop: async () => {} };
  }

  const logger = {
    info: deps.logger?.info ?? defaultLogger.info,
    warn: deps.logger?.warn ?? defaultLogger.warn,
    debug: deps.logger?.debug ?? defaultLogger.debug,
  };
  const { getResponder, Protocol } = await loadCiaoModule();
  const restoreConsoleLog = installCiaoConsoleNoiseFilter();

  const handleCiaoUnhandledRejection = (reason: unknown): boolean => {
    const classification = classifyCiaoUnhandledRejection(reason);
    if (!classification) {
      return false;
    }

    if (classification.kind === "interface-assertion") {
      logger.warn(`bonjour: suppressing ciao interface assertion: ${classification.formatted}`);
      return true;
    }

    logger.debug(`bonjour: ignoring unhandled ciao rejection: ${classification.formatted}`);
    return true;
  };

  try {
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
    if (!opts.minimal && typeof opts.tailnetDns === "string" && opts.tailnetDns.trim()) {
      txtBase.tailnetDns = opts.tailnetDns.trim();
    }
    if (!opts.minimal && typeof opts.cliPath === "string" && opts.cliPath.trim()) {
      txtBase.cliPath = opts.cliPath.trim();
    }

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
        services.length > 0 && deps.registerUnhandledRejectionHandler
          ? deps.registerUnhandledRejectionHandler(handleCiaoUnhandledRejection)
          : undefined;

      return { responder, services, cleanupUnhandledRejection };
    }

    async function stopCycle(cycle: BonjourCycle | null) {
      if (!cycle) {
        return;
      }
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
            logger.warn(
              `bonjour: ${label} name conflict resolved; newName=${JSON.stringify(next)}`,
            );
          });
          svc.on("hostname-change", (nextHostname: unknown) => {
            const next = typeof nextHostname === "string" ? nextHostname : String(nextHostname);
            logger.warn(
              `bonjour: ${label} hostname conflict resolved; newHostname=${JSON.stringify(next)}`,
            );
          });
        } catch (err) {
          logger.debug(`bonjour: failed to attach listeners for ${label}: ${String(err)}`);
        }
      }
    }

    function startAdvertising(services: Array<{ label: string; svc: BonjourService }>) {
      for (const { label, svc } of services) {
        try {
          void svc
            .advertise()
            .then(() => {
              logger.info(`bonjour: advertised ${serviceSummary(label, svc)}`);
            })
            .catch((err) => {
              logger.warn(
                `bonjour: advertise failed (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`,
              );
            });
        } catch (err) {
          logger.warn(
            `bonjour: advertise threw (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`,
          );
        }
      }
    }

    logger.debug(
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
        const nextState = typeof svc.serviceState === "string" ? svc.serviceState : "unknown";
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
        logger.warn(`bonjour: restarting advertiser (${reason})`);
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

        logger.warn(
          `bonjour: watchdog detected non-announced service; attempting re-advertise (${serviceSummary(
            label,
            svc,
          )})`,
        );
        try {
          void svc.advertise().catch((err) => {
            logger.warn(
              `bonjour: watchdog re-advertise failed (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`,
            );
          });
        } catch (err) {
          logger.warn(
            `bonjour: watchdog re-advertise threw (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`,
          );
        }
      }
    }, WATCHDOG_INTERVAL_MS);
    watchdog.unref?.();

    return {
      stop: async () => {
        stopped = true;
        clearInterval(watchdog);
        try {
          await recreatePromise;
        } catch {
          // ignore
        }
        await stopCycle(cycle);
        restoreConsoleLog();
      },
    };
  } catch (err) {
    restoreConsoleLog();
    throw err;
  }
}
