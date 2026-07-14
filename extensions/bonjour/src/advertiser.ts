/** Publishes gateway/canvas/SSH records and repairs stuck or conflicting ciao advertisements. */
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import type { CiaoService } from "@homebridge/ciao";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";
import { classifyCiaoProcessError, type CiaoProcessErrorClassification } from "./ciao.js";
import { formatBonjourError } from "./errors.js";

const nodeRequire = createRequire(import.meta.url);
const childProcessModule = nodeRequire("node:child_process") as {
  exec: typeof import("node:child_process").exec;
};

type GatewayBonjourAdvertiser = {
  stop: () => Promise<void>;
};

/** Input data used to publish OpenClaw gateway Bonjour records. */
type GatewayBonjourAdvertiseOpts = {
  instanceName?: string;
  gatewayPort: number;
  sshPort?: number;
  gatewayTlsEnabled?: boolean;
  gatewayTlsFingerprintSha256?: string;
  gatewayDirectReachable?: boolean;
  canvasPort?: number;
  tailnetDns?: string;
  cliPath?: string;
  minimal?: boolean;
};

type BonjourCycle = Array<{ label: string; svc: CiaoService }>;

type ServiceStateTracker = {
  state: CiaoService["serviceState"];
  sinceMs: number;
};

type ConsoleLogFn = (...args: unknown[]) => void;
type UncaughtExceptionHandler = (error: unknown) => boolean;
type UnhandledRejectionHandler = (reason: unknown) => boolean;
type ProcessUnhandledRejectionListener = (reason: unknown, promise: Promise<unknown>) => void;
type ExecBridge = (command: string, options?: unknown, callback?: unknown) => ChildProcess;
type ExecOptionsRecord = Record<string, unknown> & { windowsHide?: boolean };

type BonjourAdvertiserDeps = {
  logger?: Pick<PluginLogger, "info" | "warn" | "debug">;
  registerUncaughtExceptionHandler?: (handler: UncaughtExceptionHandler) => () => void;
  registerUnhandledRejectionHandler?: (handler: UnhandledRejectionHandler) => () => void;
};

const WATCHDOG_INTERVAL_MS = 5_000;
const REPAIR_DEBOUNCE_MS = 30_000;
const CONFLICT_SETTLE_MS = 30_000;
// LAN announce typically takes 12-13s on Mac/iOS. A 20s threshold avoids false-positive
// restart teardowns while still catching advertisers that never complete.
// See https://github.com/openclaw/openclaw/issues/72481
const STUCK_ANNOUNCING_MS = 20_000;
const MAX_CONSECUTIVE_RESTARTS = 3;
const MAX_CONSECUTIVE_STUCK_STATE_RESTARTS = 1;
// Bound total restarts because flapping can briefly reset the consecutive counter.
const RESTART_WINDOW_MS = 30 * 60_000;
const MAX_RESTARTS_IN_WINDOW = 5;
const CIAO_SELF_PROBE_RETRY_FRAGMENT =
  "failed probing with reason: Error: Can't probe for a service which is announced already.";

const defaultLogger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
  debug: (_msg: string) => {},
};

const CIAO_WINDOWS_SHELL_COMMANDS = new Set(['arp -a | findstr /C:"---"']);
let ciaoExecHidePatchDepth = 0;
let restoreCiaoExecHidePatchOnce: (() => void) | null = null;

function readBonjourDisableOverride(): boolean | null {
  const raw = process.env.OPENCLAW_DISABLE_BONJOUR;
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (isTruthyEnvValue(raw)) {
    return true;
  }
  switch (normalized) {
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return null;
  }
}

function isContainerEnvironment() {
  if (process.env.FLY_MACHINE_ID?.trim() && process.env.FLY_APP_NAME?.trim()) {
    return true;
  }

  for (const sentinelPath of ["/.dockerenv", "/run/.containerenv", "/var/run/.containerenv"]) {
    try {
      if (fs.existsSync(sentinelPath)) {
        return true;
      }
    } catch {
      // ignore
    }
  }

  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    return /\/docker\/|cri-containerd-[0-9a-f]|containerd\/[0-9a-f]{64}|\/kubepods[/.]|\blxc\b/u.test(
      cgroup,
    );
  } catch {
    return false;
  }
}

function isDisabledByEnv() {
  if (process.env.NODE_ENV === "test") {
    return true;
  }
  if (process.env.VITEST) {
    return true;
  }
  const envOverride = readBonjourDisableOverride();
  if (envOverride !== null) {
    return envOverride;
  }
  if (isContainerEnvironment()) {
    return true;
  }
  return false;
}

function resolveSystemMdnsHostname(): string | null {
  let raw: string;
  try {
    raw = os.hostname();
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const firstLabel =
    trimmed
      .replace(/\.local$/i, "")
      .split(".")[0]
      ?.trim() ?? "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(firstLabel)) {
    return null;
  }
  return firstLabel;
}

const MAX_DNS_LABEL_BYTES = 63;
const utf8Encoder = new TextEncoder();

function truncateToDnsLabel(name: string, fallback = "OpenClaw"): string {
  const encoded = utf8Encoder.encode(name);
  if (encoded.byteLength <= MAX_DNS_LABEL_BYTES) {
    return name;
  }
  for (let end = MAX_DNS_LABEL_BYTES; end > 0; end -= 1) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end));
      return decoded.replace(/-+$/, "").trim() || fallback;
    } catch {
      // Try the next shorter prefix until the byte slice ends on a UTF-8 boundary.
    }
  }
  return fallback;
}

function safeServiceName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 ? truncateToDnsLabel(trimmed) : "OpenClaw";
}

function prettifyInstanceName(name: string) {
  const normalized = name.trim().replace(/\s+/g, " ");
  return normalized.replace(/\s+\(OpenClaw\)\s*$/i, "").trim() || normalized;
}

function serviceSummary(label: string, svc: CiaoService): string {
  return `${label} fqdn=${svc.getFQDN()} host=${svc.getHostname()} port=${svc.getPort()} state=${svc.serviceState}`;
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

function isExecOptionsRecord(value: unknown): value is ExecOptionsRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function shouldHideCiaoWindowsShell(command: string): boolean {
  return process.platform === "win32" && CIAO_WINDOWS_SHELL_COMMANDS.has(command.trim());
}

function installCiaoWindowsExecHidePatch(): () => void {
  if (process.platform !== "win32") {
    return () => {};
  }

  ciaoExecHidePatchDepth += 1;
  if (!restoreCiaoExecHidePatchOnce) {
    const previousExec = childProcessModule.exec as ExecBridge;
    const wrapper = ((command: string, options?: unknown, callback?: unknown) => {
      if (shouldHideCiaoWindowsShell(command)) {
        if (typeof options === "function") {
          return previousExec.call(childProcessModule, command, { windowsHide: true }, options);
        }
        if (options == null) {
          return previousExec.call(childProcessModule, command, { windowsHide: true }, callback);
        }
        if (isExecOptionsRecord(options) && options.windowsHide === undefined) {
          return previousExec.call(
            childProcessModule,
            command,
            { ...options, windowsHide: true },
            callback,
          );
        }
      }
      return previousExec.call(childProcessModule, command, options, callback);
    }) as typeof childProcessModule.exec;
    childProcessModule.exec = wrapper;
    restoreCiaoExecHidePatchOnce = () => {
      if (childProcessModule.exec === wrapper) {
        childProcessModule.exec = previousExec as typeof childProcessModule.exec;
      }
    };
  }

  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    ciaoExecHidePatchDepth = Math.max(0, ciaoExecHidePatchDepth - 1);
    if (ciaoExecHidePatchDepth > 0) {
      return;
    }
    restoreCiaoExecHidePatchOnce?.();
    restoreCiaoExecHidePatchOnce = null;
  };
}

function installCiaoUnhandledRejectionListener(handler: UnhandledRejectionHandler): () => void {
  const hadOtherListeners = process.listenerCount("unhandledRejection") > 0;
  const listener: ProcessUnhandledRejectionListener = (reason) => {
    if (handler(reason)) {
      return;
    }
    if (hadOtherListeners) {
      return;
    }
    queueMicrotask(() => {
      throw reason instanceof Error ? reason : new Error(String(reason));
    });
  };
  process.on("unhandledRejection", listener);
  return () => {
    process.off("unhandledRejection", listener);
  };
}

/** Start Bonjour advertisements for the local gateway services. */
export async function startGatewayBonjourAdvertiser(
  opts: GatewayBonjourAdvertiseOpts,
  deps: BonjourAdvertiserDeps = {},
): Promise<GatewayBonjourAdvertiser> {
  if (isDisabledByEnv()) {
    return { stop: async () => {} };
  }
  const announcedState = "announced" as CiaoService["serviceState"];
  const activeStates = new Set<CiaoService["serviceState"]>([
    announcedState,
    "announcing" as CiaoService["serviceState"],
    "probing" as CiaoService["serviceState"],
  ]);

  const logger = {
    info: deps.logger?.info ?? defaultLogger.info,
    warn: deps.logger?.warn ?? defaultLogger.warn,
    debug: deps.logger?.debug ?? defaultLogger.debug,
  };
  const restoreCiaoExecHidePatch = installCiaoWindowsExecHidePatch();
  let restoreConsoleLog: () => void = () => {};
  let requestCiaoRecovery: ((classification: CiaoProcessErrorClassification) => void) | undefined;
  let cleanupUnhandledRejection: (() => void) | undefined;
  let cleanupDirectUnhandledRejection: (() => void) | undefined;
  let cleanupUncaughtException: (() => void) | undefined;
  let processHandlersCleaned = false;

  function cleanupProcessHandlers() {
    if (processHandlersCleaned) {
      return;
    }
    processHandlersCleaned = true;
    cleanupDirectUnhandledRejection?.();
    cleanupUncaughtException?.();
    cleanupUnhandledRejection?.();
  }

  try {
    const { getResponder } = await import("@homebridge/ciao");
    restoreConsoleLog = installCiaoConsoleNoiseFilter();
    const handleCiaoProcessError = (reason: unknown): boolean => {
      const classification = classifyCiaoProcessError(reason);
      if (!classification) {
        return false;
      }

      if (classification.kind === "cancellation") {
        logger.warn(`bonjour: suppressing ciao cancellation: ${classification.formatted}`);
        requestCiaoRecovery?.(classification);
      } else if (classification.kind === "interface-enumeration-failure") {
        // Restricted sandboxes can refuse os.networkInterfaces(); mDNS cannot
        // function without it, so surface a single warning and skip recovery.
        // Recovery would just re-enter the same failing syscall.
        logger.warn(
          `bonjour: disabling mDNS — networkInterfaces() unavailable in this environment: ${classification.formatted}`,
        );
      } else {
        const label =
          classification.kind === "netmask-assertion"
            ? "netmask assertion"
            : classification.kind === "self-probe"
              ? "self-probe race"
              : "interface assertion";
        logger.warn(`bonjour: suppressing ciao ${label}: ${classification.formatted}`);
        requestCiaoRecovery?.(classification);
      }
      return true;
    };
    cleanupDirectUnhandledRejection = installCiaoUnhandledRejectionListener(handleCiaoProcessError);
    cleanupUnhandledRejection = deps.registerUnhandledRejectionHandler?.(handleCiaoProcessError);
    cleanupUncaughtException = deps.registerUncaughtExceptionHandler?.(handleCiaoProcessError);

    const hostnameRaw =
      process.env.OPENCLAW_MDNS_HOSTNAME?.trim() || resolveSystemMdnsHostname() || "openclaw";
    const hostnameWithoutLocal = hostnameRaw.replace(/\.local$/i, "");
    const dotIndex = hostnameWithoutLocal.indexOf(".");
    const labelEnd = dotIndex === -1 ? hostnameWithoutLocal.length : dotIndex;
    const hostnameLabel = hostnameWithoutLocal.slice(0, labelEnd).trim() || "openclaw";
    const hostname = truncateToDnsLabel(hostnameLabel, "openclaw");
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
    if (opts.gatewayDirectReachable) {
      txtBase.gatewayDirectReachable = "1";
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

    const responder = getResponder();

    function createCycle(): BonjourCycle {
      const services: BonjourCycle = [];

      const gateway = responder.createService({
        name: safeServiceName(instanceName),
        type: "openclaw-gw",
        port: opts.gatewayPort,
        domain: "local",
        hostname,
        txt: gatewayTxt,
      });
      services.push({
        label: "gateway",
        svc: gateway,
      });

      return services;
    }

    async function stopCycle(
      cycle: BonjourCycle | null,
      optsValue?: { shutdownResponder?: boolean },
    ) {
      if (!cycle) {
        return;
      }
      for (const { svc } of cycle) {
        try {
          await svc.destroy();
        } catch {
          /* ignore */
        }
      }
      try {
        if (optsValue?.shutdownResponder) {
          await responder.shutdown();
        }
      } catch {
        /* ignore */
      }
    }

    function attachConflictListeners(services: BonjourCycle) {
      for (const { label, svc } of services) {
        try {
          svc.on("name-change", (name) => {
            markConflictObserved(label, svc);
            logger.warn(
              `bonjour: ${label} name conflict resolved; newName=${JSON.stringify(name)}`,
            );
          });
          svc.on("hostname-change", (nextHostname) => {
            markConflictObserved(label, svc);
            logger.warn(
              `bonjour: ${label} hostname conflict resolved; newHostname=${JSON.stringify(nextHostname)}`,
            );
          });
        } catch (err) {
          logger.debug(`bonjour: failed to attach listeners for ${label}: ${String(err)}`);
        }
      }
    }

    function handleAdvertiseFailure(
      label: string,
      svc: CiaoService,
      err: unknown,
      action: "failed" | "threw",
    ) {
      const classification = classifyCiaoProcessError(err);
      if (classification) {
        logger.warn(
          `bonjour: advertise ${action} with ciao ${classification.kind} (${serviceSummary(
            label,
            svc,
          )}): ${classification.formatted}`,
        );
        requestCiaoRecovery?.(classification);
        return;
      }
      logger.warn(
        `bonjour: advertise ${action} (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`,
      );
    }

    function startAdvertising(services: BonjourCycle) {
      for (const { label, svc } of services) {
        try {
          void svc
            .advertise()
            .then(() => {
              logger.info(`bonjour: advertised ${serviceSummary(label, svc)}`);
            })
            .catch((err: unknown) => {
              handleAdvertiseFailure(label, svc, err, "failed");
            });
        } catch (err) {
          handleAdvertiseFailure(label, svc, err, "threw");
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
    let disabled = false;
    let consecutiveRestarts = 0;
    let consecutiveStuckStateRestarts = 0;
    const restartTimestamps: number[] = [];
    let cycle: BonjourCycle | null = createCycle();
    const stateTracker = new Map<string, ServiceStateTracker>();
    const conflictTracker = new Map<string, number>();

    const markConflictObserved = (label: string, svc: CiaoService) => {
      const now = Date.now();
      conflictTracker.set(label, now);
      stateTracker.set(label, { state: svc.serviceState, sinceMs: now });
    };

    const updateStateTrackers = (services: BonjourCycle) => {
      const now = Date.now();
      for (const { label, svc } of services) {
        const nextState = svc.serviceState;
        const current = stateTracker.get(label);
        const nextEnteredAt =
          current && current.state !== announcedState && nextState !== announcedState
            ? current.sinceMs
            : now;
        if (!current || current.state !== nextState || current.sinceMs !== nextEnteredAt) {
          stateTracker.set(label, { state: nextState, sinceMs: nextEnteredAt });
        }
      }
    };

    const recreateAdvertiser = async (reason: string, optsLocal?: { stuckState?: boolean }) => {
      if (stopped || disabled) {
        return;
      }
      if (recreatePromise) {
        return recreatePromise;
      }
      recreatePromise = (async () => {
        consecutiveRestarts += 1;
        consecutiveStuckStateRestarts = optsLocal?.stuckState
          ? consecutiveStuckStateRestarts + 1
          : 0;
        const now = Date.now();
        while (
          restartTimestamps.length > 0 &&
          now - (restartTimestamps[0] ?? 0) > RESTART_WINDOW_MS
        ) {
          restartTimestamps.shift();
        }
        restartTimestamps.push(now);
        const tooManyConsecutive = consecutiveRestarts > MAX_CONSECUTIVE_RESTARTS;
        const tooManyStuckStates =
          consecutiveStuckStateRestarts > MAX_CONSECUTIVE_STUCK_STATE_RESTARTS;
        const tooManyInWindow = restartTimestamps.length >= MAX_RESTARTS_IN_WINDOW;
        if (tooManyConsecutive || tooManyStuckStates || tooManyInWindow) {
          disabled = true;
          const detail = tooManyConsecutive
            ? `${MAX_CONSECUTIVE_RESTARTS} failed restarts`
            : tooManyStuckStates
              ? `${MAX_CONSECUTIVE_STUCK_STATE_RESTARTS} stuck-state restart`
              : `${MAX_RESTARTS_IN_WINDOW} restarts within ${Math.round(
                  RESTART_WINDOW_MS / 60_000,
                )} minutes`;
          logger.warn(
            `bonjour: disabling advertiser after ${detail} (${reason}); set discovery.mdns.mode="off" or OPENCLAW_DISABLE_BONJOUR=1 to disable mDNS discovery`,
          );
          const previous = cycle;
          cycle = null;
          stateTracker.clear();
          conflictTracker.clear();
          await stopCycle(previous, { shutdownResponder: true });
          restoreConsoleLog();
          restoreCiaoExecHidePatch();
          return;
        }
        logger.warn(`bonjour: restarting advertiser (${reason})`);
        const previous = cycle;
        await stopCycle(previous);
        cycle = createCycle();
        stateTracker.clear();
        conflictTracker.clear();
        attachConflictListeners(cycle);
        startAdvertising(cycle);
      })().finally(() => {
        recreatePromise = null;
      });
      return recreatePromise;
    };
    requestCiaoRecovery = (classification) => {
      void recreateAdvertiser(`ciao ${classification.kind}: ${classification.formatted}`);
    };
    attachConflictListeners(cycle);
    startAdvertising(cycle);

    const lastRepairAttempt = new Map<string, number>();
    const watchdog = setInterval(() => {
      if (stopped || recreatePromise) {
        return;
      }
      if (disabled || !cycle) {
        return;
      }
      updateStateTrackers(cycle);
      for (const { label, svc } of cycle) {
        const now = Date.now();
        const state = svc.serviceState;
        if (state === announcedState) {
          consecutiveRestarts = 0;
          consecutiveStuckStateRestarts = 0;
          conflictTracker.delete(label);
        }
        const lastConflictAt = conflictTracker.get(label);
        if (lastConflictAt !== undefined && now - lastConflictAt >= CONFLICT_SETTLE_MS) {
          conflictTracker.delete(label);
        }
        if (lastConflictAt !== undefined && now - lastConflictAt < CONFLICT_SETTLE_MS) {
          continue;
        }
        const tracked = stateTracker.get(label);
        if (state !== announcedState && tracked && now - tracked.sinceMs >= STUCK_ANNOUNCING_MS) {
          void recreateAdvertiser(
            `service stuck in ${state} for ${now - tracked.sinceMs}ms (${serviceSummary(
              label,
              svc,
            )})`,
            { stuckState: true },
          );
          return;
        }
        if (activeStates.has(state)) {
          continue;
        }

        let key = label;
        try {
          key = `${label}:${svc.getFQDN()}`;
        } catch {
          // ignore
        }
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
          void svc.advertise().catch((err: unknown) => {
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
        await stopCycle(cycle, { shutdownResponder: true });
        restoreConsoleLog();
        restoreCiaoExecHidePatch();
        cleanupProcessHandlers();
      },
    };
  } catch (err) {
    restoreConsoleLog();
    restoreCiaoExecHidePatch();
    cleanupProcessHandlers();
    throw err;
  }
}
