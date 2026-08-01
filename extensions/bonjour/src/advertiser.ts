/** Publishes gateway/canvas/SSH records through one ciao-owned advertisement lifecycle. */
import fs from "node:fs";
import os from "node:os";
import type { CiaoService } from "@homebridge/ciao";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";
import { classifyCiaoProcessError } from "./ciao.js";
import { formatBonjourError } from "./errors.js";

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

type BonjourServices = Array<{ label: string; svc: CiaoService }>;

type ConsoleLogFn = (...args: unknown[]) => void;
type UncaughtExceptionHandler = (error: unknown) => boolean;
type UnhandledRejectionHandler = (reason: unknown) => boolean;

type BonjourAdvertiserDeps = {
  logger?: Pick<PluginLogger, "info" | "warn" | "debug">;
  registerUncaughtExceptionHandler: (handler: UncaughtExceptionHandler) => () => void;
  registerUnhandledRejectionHandler: (handler: UnhandledRejectionHandler) => () => void;
};

const CIAO_SELF_PROBE_RETRY_FRAGMENT =
  "failed probing with reason: Error: Can't probe for a service which is announced already.";

const defaultLogger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
  debug: (_msg: string) => {},
};

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

/** Start Bonjour advertisements for the local gateway services. */
export async function startGatewayBonjourAdvertiser(
  opts: GatewayBonjourAdvertiseOpts,
  deps: BonjourAdvertiserDeps,
): Promise<GatewayBonjourAdvertiser> {
  if (isDisabledByEnv()) {
    return { stop: async () => {} };
  }

  const logger = {
    info: deps.logger?.info ?? defaultLogger.info,
    warn: deps.logger?.warn ?? defaultLogger.warn,
    debug: deps.logger?.debug ?? defaultLogger.debug,
  };
  let restoreConsoleLog: () => void = () => {};
  let cleanupUnhandledRejection: (() => void) | undefined;
  let cleanupUncaughtException: (() => void) | undefined;
  let processHandlersCleaned = false;

  function cleanupProcessHandlers() {
    if (processHandlersCleaned) {
      return;
    }
    processHandlersCleaned = true;
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

      if (classification.kind === "interface-enumeration-failure") {
        // Restricted sandboxes can refuse os.networkInterfaces(); mDNS cannot
        // function without it, so surface a single warning and skip recovery.
        // Recovery would just re-enter the same failing syscall.
        logger.warn(
          `bonjour: disabling mDNS — networkInterfaces() unavailable in this environment: ${classification.formatted}`,
        );
      } else {
        logger.warn(`bonjour: suppressing ciao netmask assertion: ${classification.formatted}`);
      }
      return true;
    };
    cleanupUnhandledRejection = deps.registerUnhandledRejectionHandler(handleCiaoProcessError);
    cleanupUncaughtException = deps.registerUncaughtExceptionHandler(handleCiaoProcessError);

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

    function createServices(): BonjourServices {
      const services: BonjourServices = [];

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

    async function stopServices(services: BonjourServices) {
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
      }
    }

    function attachConflictListeners(services: BonjourServices) {
      for (const { label, svc } of services) {
        try {
          svc.on("name-change", (name) => {
            logger.warn(
              `bonjour: ${label} name conflict resolved; newName=${JSON.stringify(name)}`,
            );
          });
          svc.on("hostname-change", (nextHostname) => {
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
        return;
      }
      logger.warn(
        `bonjour: advertise ${action} (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`,
      );
    }

    function startAdvertising(services: BonjourServices) {
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

    const services = createServices();
    attachConflictListeners(services);
    startAdvertising(services);
    let stopPromise: Promise<void> | null = null;

    return {
      stop: () => {
        stopPromise ??= (async () => {
          await stopServices(services);
          restoreConsoleLog();
          cleanupProcessHandlers();
        })();
        return stopPromise;
      },
    };
  } catch (err) {
    restoreConsoleLog();
    cleanupProcessHandlers();
    throw err;
  }
}
