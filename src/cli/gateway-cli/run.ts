// Gateway run option resolution and local server startup command implementation.
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { TLSSocket } from "node:tls";
import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type {
  ConfigFileSnapshot,
  GatewayAuthMode,
  GatewayBindMode,
  GatewayTailscaleMode,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "../../config/config.js";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "../../config/future-version-guard.js";
import { CONFIG_AUDIT_STORE_LABEL } from "../../config/io.audit.js";
import {
  isDoctorRecoverableInvalidConfigError,
  isInvalidConfigError,
} from "../../config/io.invalid-config.js";
import { CONFIG_PATH, normalizeStateDirEnv, resolveGatewayPort } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../../daemon/constants.js";
import {
  defaultGatewayBindMode,
  isContainerEnvironment,
  isLoopbackHost,
  resolveGatewayBindHost,
} from "../../gateway/net.js";
import type { GatewayWsLogStyle } from "../../gateway/ws-logging.js";
import { setGatewayWsLogStyle } from "../../gateway/ws-logging.js";
import { setVerbose } from "../../globals.js";
import {
  formatHostingProfileIds,
  HOSTING_PROFILE_ENV,
  parseHostingProfileId,
} from "../../hosting/profiles.js";
import {
  INCARNATION_ID_ENV,
  resolveRuntimeActivationIdentity,
  RUNTIME_ID_ENV,
} from "../../hosting/runtime-activation.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  completeGatewayBootLifecycle,
  GATEWAY_CRASH_LOOP_BREAKER_REASON,
  GATEWAY_CRASH_LOOP_RECOVERED_REASON,
  inspectGatewayCrashLoopBreaker,
  recordGatewayBootStart,
  type GatewayCrashLoopBreakerDecision,
  type GatewayBootLifecycleCompletion,
} from "../../infra/gateway-boot-lifecycle.js";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import {
  findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList,
} from "../../infra/gateway-processes.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import { normalizeFingerprint } from "../../infra/tls/fingerprint.js";
import { setConsoleSubsystemFilter, setConsoleTimestampPrefix } from "../../logging/console.js";
import { withDiagnosticPhase } from "../../logging/diagnostic-phase.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import { printClawBanner, type ClawBannerResult } from "../claw-banner.js";
import { formatCliCommand } from "../command-format.js";
import { formatInvalidConfigPort, formatInvalidPortOption } from "../error-format.js";
import type { InvalidConfigRecoveryDeps } from "../invalid-config-recovery.js";
import { withProgress } from "../progress.js";
import { parsePort } from "../shared/parse-port.js";
import {
  isTerminalInteractive,
  NON_INTERACTIVE_GATEWAY_RUN_FORCE_MESSAGE,
} from "../terminal-interactivity.js";
import {
  enforceGatewayRunFutureConfigGuard,
  isGatewayRunFutureConfigAllowed,
} from "./future-config-guard.js";
import { installQaParentWatchdog } from "./qa-parent-watchdog.js";
import { runGatewayLoop } from "./run-loop.js";
import type { GatewayRunOpts } from "./run-options.js";
import type { GatewayRunRuntimeHooks } from "./runtime-hooks.js";

const gatewayLog = createSubsystemLogger("gateway");

const SUPERVISED_GATEWAY_LOCK_RETRY_MS = 5000;
const SUPERVISED_GATEWAY_LOCK_RETRY_TIMEOUT_MS = 30_000;
const SUPERVISED_GATEWAY_HEALTH_PROBE_TIMEOUT_MS = 1000;
const GATEWAY_HEALTH_PROBE_MAX_RESPONSE_CHARS = 1024;
const GATEWAY_SHELL_ENV_CONVERGENCE_MAX_READS = 4;

type Awaitable<T> = T | Promise<T>;
type GatewayRunLogger = Pick<ReturnType<typeof createSubsystemLogger>, "info" | "warn">;

/**
 * EX_CONFIG (78) from sysexits.h — used for configuration errors so systemd
 * (via RestartPreventExitStatus=78) stops restarting instead of entering a
 * restart storm that can render low-resource hosts unresponsive.
 */
const EXIT_CONFIG_ERROR = 78;

const GATEWAY_AUTH_MODES: readonly GatewayAuthMode[] = [
  "none",
  "token",
  "password",
  "trusted-proxy",
];
const GATEWAY_TAILSCALE_MODES: readonly GatewayTailscaleMode[] = ["off", "serve", "funnel"];

const toOptionString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
};

function extractGatewayMiskeys(parsed: unknown): {
  hasGatewayToken: boolean;
  hasRemoteToken: boolean;
} {
  // Detect common token misplacements before startup falls back to unauthenticated mode.
  if (!parsed || typeof parsed !== "object") {
    return { hasGatewayToken: false, hasRemoteToken: false };
  }
  const gateway = (parsed as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") {
    return { hasGatewayToken: false, hasRemoteToken: false };
  }
  const hasGatewayToken = "token" in (gateway as Record<string, unknown>);
  const remote = (gateway as Record<string, unknown>).remote;
  const hasRemoteToken =
    remote && typeof remote === "object" ? "token" in (remote as Record<string, unknown>) : false;
  return { hasGatewayToken, hasRemoteToken };
}

function createGatewayCliStartupTrace() {
  const enabled = isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE);
  const started = performance.now();
  let last = started;
  const emit = (name: string, durationMs: number, totalMs: number) => {
    if (enabled) {
      gatewayLog.info(
        `startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`,
      );
    }
  };
  const startMeasure = <T>(name: string, run: () => Awaitable<T>) => {
    const before = performance.now();
    let completedAt = before;
    let emitted = false;
    const result = withDiagnosticPhase(name, run).finally(() => {
      completedAt = performance.now();
    });
    // Attach both outcomes immediately so callers can finish terminal UI before
    // consuming or rethrowing the measured result without an unhandled rejection.
    const settled = result.then(
      () => {},
      () => {},
    );
    return {
      result,
      settled,
      emit() {
        if (emitted) {
          return;
        }
        emitted = true;
        emit(name, completedAt - before, completedAt - started);
        last = completedAt;
      },
    };
  };
  return {
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
    },
    startMeasure,
    async measure<T>(name: string, run: () => Awaitable<T>): Promise<T> {
      const measurement = startMeasure(name, run);
      try {
        return await measurement.result;
      } finally {
        await measurement.settled;
        measurement.emit();
      }
    },
  };
}

function warnInlinePasswordFlag() {
  defaultRuntime.error(
    "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
  );
}

async function resolveGatewayPasswordOption(opts: GatewayRunOpts): Promise<string | undefined> {
  const direct = toOptionString(opts.password);
  const file = toOptionString(opts.passwordFile);
  if (direct && file) {
    throw new Error("Use either --password or --password-file.");
  }
  if (file) {
    const { readSecretFromFile } = await import("../../acp/secret-file.js");
    return readSecretFromFile(file, "Gateway password");
  }
  return direct;
}

function parseEnumOption<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T | null {
  if (!raw) {
    return null;
  }
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

function formatModeErrorList(modes: readonly string[]): string {
  const quoted = modes.map((mode) => `"${mode}"`);
  if (quoted.length === 0) {
    return "";
  }
  if (quoted.length === 1) {
    return expectDefined(quoted[0], "quoted entry at 0");
  }
  if (quoted.length === 2) {
    return `${quoted[0]} or ${quoted[1]}`;
  }
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

function shouldBlockGatewayBindWithoutExplicitAuth(params: {
  bindHost: string;
  hasSharedSecret: boolean;
  resolvedAuthMode: GatewayAuthMode;
}): boolean {
  return (
    !isLoopbackHost(params.bindHost) &&
    !params.hasSharedSecret &&
    params.resolvedAuthMode !== "trusted-proxy"
  );
}

function getGatewayStartGuardErrors(params: {
  allowUnconfigured?: boolean;
  configExists: boolean;
  configAuditLocation: string;
  mode: string | undefined;
}): string[] {
  if (params.allowUnconfigured || params.mode === "local") {
    return [];
  }
  if (!params.configExists) {
    return [
      `Missing config. Run \`${formatCliCommand("openclaw setup")}\` or set gateway.mode=local (or pass --allow-unconfigured).`,
    ];
  }
  if (params.mode === undefined) {
    return [
      [
        "Gateway start blocked: existing config is missing gateway.mode.",
        "Treat this as suspicious or clobbered config.",
        `Re-run \`${formatCliCommand("openclaw onboard --mode local")}\` or \`${formatCliCommand("openclaw setup")}\`, set gateway.mode=local manually, or pass --allow-unconfigured.`,
      ].join(" "),
      `Config write audit: ${params.configAuditLocation}`,
    ];
  }
  return [
    `Gateway start blocked: set gateway.mode=local (current: ${params.mode}) or pass --allow-unconfigured.`,
    `Config write audit: ${params.configAuditLocation}`,
  ];
}

async function readGatewayStartupConfig(params: {
  lowerPrecedenceEnv: Readonly<Record<string, string>>;
  opts: GatewayRunOpts;
  startupTrace: ReturnType<typeof createGatewayCliStartupTrace>;
}): Promise<{
  cfg: OpenClawConfig;
  snapshot: ConfigFileSnapshot | null;
  startupConfigSnapshotRead?: ReadConfigFileSnapshotWithPluginMetadataResult;
}> {
  const { readConfigFileSnapshotWithPluginMetadata } = await import("../../config/config.js");
  let blockedRecoveryConfig: OpenClawConfig | null = null;
  const snapshotRead: ReadConfigFileSnapshotWithPluginMetadataResult | null =
    await params.startupTrace.measure("cli.config-snapshot", () =>
      readConfigFileSnapshotWithPluginMetadata({
        isolateEnv: true,
        ...(Object.keys(params.lowerPrecedenceEnv).length > 0
          ? { lowerPrecedenceEnv: params.lowerPrecedenceEnv }
          : {}),
        recoverSuspicious: true,
        allowSuspiciousRecovery: (config, current) => {
          const blockedConfig = [current, config].find(
            (candidate) =>
              !isGatewayRunFutureConfigAllowed({ opts: params.opts, config: candidate }),
          );
          if (!blockedConfig) {
            return true;
          }
          blockedRecoveryConfig = blockedConfig;
          return false;
        },
      }).catch(() => null),
    );
  if (blockedRecoveryConfig) {
    enforceGatewayRunFutureConfigGuard({
      opts: params.opts,
      runtime: defaultRuntime,
      config: blockedRecoveryConfig,
    });
  }
  const snapshot: ConfigFileSnapshot | null = snapshotRead?.snapshot ?? null;
  const cfg = snapshot?.config ?? {};
  return {
    cfg,
    snapshot,
    ...(snapshotRead ? { startupConfigSnapshotRead: snapshotRead } : {}),
  };
}

type GatewayRunShellEnvFallbackPlan =
  | { enabled: false }
  | {
      enabled: true;
      expectedKeys: string[];
      timeoutMs: number;
    };

async function resolveGatewayRunShellEnvFallbackPlan(
  cfg: OpenClawConfig,
): Promise<GatewayRunShellEnvFallbackPlan> {
  const { createConfigRuntimeEnv } = await import("../../config/env-vars.js");
  const {
    resolveShellEnvFallbackTimeoutMs,
    shouldDeferShellEnvFallback,
    shouldEnableShellEnvFallback,
  } = await import("../../infra/shell-env.js");
  const planEnv = createConfigRuntimeEnv(cfg, process.env);
  const enabled =
    (shouldEnableShellEnvFallback(planEnv) || cfg.env?.shellEnv?.enabled === true) &&
    !shouldDeferShellEnvFallback(planEnv);
  if (!enabled) {
    return { enabled: false };
  }
  const { resolveShellEnvExpectedKeys } = await import("../../config/shell-env-expected-keys.js");
  return {
    enabled: true,
    expectedKeys: resolveShellEnvExpectedKeys(planEnv),
    timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(planEnv),
  };
}

async function loadGatewayRunShellEnvFallback(
  plan: Extract<GatewayRunShellEnvFallbackPlan, { enabled: true }>,
): Promise<Record<string, string>> {
  const { loadShellEnvFallback } = await import("../../infra/shell-env.js");
  const valuesBeforeLoad = new Map(plan.expectedKeys.map((key) => [key, process.env[key]]));
  loadShellEnvFallback({
    enabled: true,
    env: process.env,
    expectedKeys: plan.expectedKeys,
    logger: gatewayLog,
    timeoutMs: plan.timeoutMs,
  });
  return Object.fromEntries(
    plan.expectedKeys.flatMap((key) => {
      const value = process.env[key];
      return value !== undefined && value !== valuesBeforeLoad.get(key) ? [[key, value]] : [];
    }),
  );
}

async function clearGatewayRunShellEnvFallback(
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const keys = Object.keys(values);
  if (keys.length === 0) {
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === value) {
      delete process.env[key];
    }
  }
  const { clearShellEnvAppliedKeys } = await import("../../infra/shell-env.js");
  clearShellEnvAppliedKeys(keys);
}

function gatewayRunShellEnvFallbackPlanSignature(plan: GatewayRunShellEnvFallbackPlan): string {
  return JSON.stringify(plan);
}

async function readGatewayStartupConfigWithShellEnv(params: {
  opts: GatewayRunOpts;
  startupTrace: ReturnType<typeof createGatewayCliStartupTrace>;
}): Promise<
  Awaited<ReturnType<typeof readGatewayStartupConfig>> & {
    lowerPrecedenceEnv: Readonly<Record<string, string>>;
  }
> {
  let lowerPrecedenceEnv: Record<string, string> = {};
  let loadedPlanSignature: string | undefined;
  try {
    for (let readCount = 0; readCount < GATEWAY_SHELL_ENV_CONVERGENCE_MAX_READS; readCount += 1) {
      const startupConfig = await readGatewayStartupConfig({
        lowerPrecedenceEnv,
        opts: params.opts,
        startupTrace: params.startupTrace,
      });
      const plan = await resolveGatewayRunShellEnvFallbackPlan(
        startupConfig.snapshot?.valid === true ? startupConfig.cfg : {},
      );
      const planSignature = gatewayRunShellEnvFallbackPlanSignature(plan);
      if (!plan.enabled) {
        if (Object.keys(lowerPrecedenceEnv).length === 0) {
          return { ...startupConfig, lowerPrecedenceEnv };
        }
        await clearGatewayRunShellEnvFallback(lowerPrecedenceEnv);
        lowerPrecedenceEnv = {};
        loadedPlanSignature = undefined;
        continue;
      }
      if (loadedPlanSignature === planSignature) {
        return { ...startupConfig, lowerPrecedenceEnv };
      }
      await clearGatewayRunShellEnvFallback(lowerPrecedenceEnv);
      lowerPrecedenceEnv = await loadGatewayRunShellEnvFallback(plan);
      loadedPlanSignature = planSignature;
    }
  } catch (err) {
    await clearGatewayRunShellEnvFallback(lowerPrecedenceEnv);
    throw err;
  }
  await clearGatewayRunShellEnvFallback(lowerPrecedenceEnv);
  throw new Error(
    "Gateway shell environment fallback settings changed repeatedly during startup. Retry startup.",
  );
}

function isGatewayLockError(err: unknown): err is GatewayLockError {
  return (
    err instanceof GatewayLockError ||
    (Boolean(err) &&
      typeof err === "object" &&
      (err as { name?: string }).name === "GatewayLockError")
  );
}

function isGatewayAlreadyRunningLockError(err: unknown): boolean {
  if (!isGatewayLockError(err) || typeof err.message !== "string") {
    return false;
  }
  return (
    err.message.includes("gateway already running") ||
    err.message.includes("another gateway instance is already listening")
  );
}

class SupervisedGatewayLockError extends GatewayLockError {
  constructor(
    message: string,
    cause: unknown,
    readonly exitCode: 1 | typeof EXIT_CONFIG_ERROR,
  ) {
    super(message, cause);
  }
}

function resolveGatewayLockErrorExitCode(err: unknown): number {
  return err instanceof SupervisedGatewayLockError ? err.exitCode : 1;
}

function resolveGatewayStartupFailureExitCode(err: unknown): number {
  return isInvalidConfigError(err) ? EXIT_CONFIG_ERROR : 1;
}

function normalizeGatewayHealthProbeHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }
  return host;
}

function isGatewayHealthzResponse(statusCode: number | undefined, body: string): boolean {
  if (statusCode !== 200) {
    return false;
  }
  try {
    const payload = JSON.parse(body) as { ok?: unknown; status?: unknown };
    return payload.ok === true && payload.status === "live";
  } catch {
    return false;
  }
}

async function probeGatewayHealthz(params: {
  host: string;
  port: number;
  timeoutMs?: number;
  tlsFingerprint?: string;
}): Promise<boolean> {
  const timeoutMs = params.timeoutMs ?? SUPERVISED_GATEWAY_HEALTH_PROBE_TIMEOUT_MS;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (healthy: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      resolve(healthy);
    };
    const request = params.tlsFingerprint ? httpsRequest : httpRequest;
    const req = request(
      {
        hostname: normalizeGatewayHealthProbeHost(params.host),
        port: params.port,
        path: "/healthz",
        method: "GET",
        timeout: timeoutMs,
        // The probe sends no credentials. Pin the configured certificate below
        // before accepting a self-signed gateway's liveness payload.
        ...(params.tlsFingerprint ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        if (params.tlsFingerprint) {
          const peerFingerprint =
            res.socket instanceof TLSSocket
              ? normalizeFingerprint(res.socket.getPeerCertificate().fingerprint256 ?? "")
              : "";
          if (peerFingerprint !== normalizeFingerprint(params.tlsFingerprint)) {
            res.resume();
            finish(false);
            return;
          }
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length + chunk.length > GATEWAY_HEALTH_PROBE_MAX_RESPONSE_CHARS) {
            res.destroy();
            finish(false);
            return;
          }
          body += chunk;
        });
        res.once("end", () => {
          finish(isGatewayHealthzResponse(res.statusCode, body));
        });
        res.once("error", () => {
          finish(false);
        });
      },
    );
    const deadline = setTimeout(() => {
      req.destroy();
      finish(false);
    }, timeoutMs);
    req.once("timeout", () => {
      req.destroy();
      finish(false);
    });
    req.once("error", () => {
      finish(false);
    });
    req.end();
  });
}

function createConfiguredGatewayHealthProbe(cfg: OpenClawConfig) {
  const tlsConfig = cfg.gateway?.tls;
  let tlsFingerprint: string | undefined;
  return async (params: { host: string; port: number }): Promise<boolean> => {
    if (tlsConfig?.enabled !== true) {
      return await probeGatewayHealthz(params);
    }
    if (!tlsFingerprint) {
      const gatewayTls = await import("../../infra/tls/gateway.js")
        .then(({ loadGatewayTlsRuntime }) =>
          loadGatewayTlsRuntime({ ...tlsConfig, autoGenerate: false }),
        )
        .catch(() => undefined);
      tlsFingerprint = gatewayTls?.fingerprintSha256;
    }
    if (!tlsFingerprint) {
      return false;
    }
    return await probeGatewayHealthz({ ...params, tlsFingerprint });
  };
}

async function runGatewayLoopWithSupervisedLockRecovery(params: {
  startLoop: () => Promise<void>;
  supervisor: RespawnSupervisor | null;
  port: number;
  healthHost: string;
  log: GatewayRunLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probeHealth?: (params: { host: string; port: number }) => Promise<boolean>;
  retryMs?: number;
  timeoutMs?: number;
}) {
  const supervisor = params.supervisor;
  if (!supervisor) {
    await params.startLoop();
    return;
  }

  const now = params.now ?? Date.now;
  const sleep =
    params.sleep ??
    (async (ms: number) =>
      await new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
  const probeHealth = params.probeHealth ?? ((probeParams) => probeGatewayHealthz(probeParams));
  const retryMs = params.retryMs ?? SUPERVISED_GATEWAY_LOCK_RETRY_MS;
  const timeoutMs = params.timeoutMs ?? SUPERVISED_GATEWAY_LOCK_RETRY_TIMEOUT_MS;
  const startedAt = now();

  for (;;) {
    try {
      await params.startLoop();
      return;
    } catch (err) {
      if (!isGatewayAlreadyRunningLockError(err)) {
        throw err;
      }

      if (await probeHealth({ host: params.healthHost, port: params.port })) {
        if (supervisor === "systemd") {
          throw new SupervisedGatewayLockError(
            "gateway already running under systemd; existing gateway is healthy, exiting with code 78 to prevent a systemd Restart=always loop",
            err,
            EXIT_CONFIG_ERROR,
          );
        }
        params.log.info(
          `gateway already running under ${supervisor}; existing gateway is healthy, leaving it in control`,
        );
        return;
      }

      const elapsedMs = now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        throw new SupervisedGatewayLockError(
          `gateway already running under ${supervisor}; existing gateway did not become healthy after ${timeoutMs}ms`,
          err,
          1,
        );
      }

      const waitMs = Math.min(retryMs, Math.max(0, timeoutMs - elapsedMs));
      params.log.warn(
        `gateway already running under ${supervisor}; waiting ${waitMs}ms before retrying startup`,
      );
      await sleep(waitMs);
    }
  }
}

async function maybeWriteGatewayStartupFailureBundle(
  err: unknown,
  reason = "gateway.startup_failed",
): Promise<void> {
  const { writeDiagnosticStabilityBundleForFailureSync } =
    await import("../../logging/diagnostic-stability-bundle.js");
  const result = writeDiagnosticStabilityBundleForFailureSync(reason, err);
  if ("message" in result) {
    gatewayLog.warn(result.message);
  }
}

async function runGatewayCommandOnce(opts: GatewayRunOpts, hooks: GatewayRunRuntimeHooks = {}) {
  // Reparenting can hide the running service from the ancestor walk.
  // Preserve its inherited PID before config env rebuilding overwrites it.
  const inheritedGatewayServicePid = parseStrictPositiveInteger(
    process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV],
  );
  normalizeStateDirEnv(process.env);
  const { clearGatewayRunConfigEnvironment } = await import("./pre-bootstrap.js");
  clearGatewayRunConfigEnvironment();
  installQaParentWatchdog();
  const isDevProfile = normalizeOptionalLowercaseString(process.env.OPENCLAW_PROFILE) === "dev";
  const devMode = Boolean(opts.dev) || isDevProfile;
  // Dev gateways inherit the operator shell. Suppress ambient channel credentials so a
  // development instance cannot silently connect to real channel services.
  const devAmbientEnvTriggers = opts.devAmbientChannels ? "allow" : "suppress";
  if (opts.reset && !devMode) {
    defaultRuntime.error("Use --reset with --dev.");
    defaultRuntime.exit(1);
    return;
  }
  if (opts.devAmbientChannels && !devMode) {
    defaultRuntime.error("Use --dev-ambient-channels with --dev.");
    defaultRuntime.exit(1);
    return;
  }
  setVerbose(Boolean(opts.verbose));
  const hostingProfileRaw = toOptionString(opts.hostingProfile);
  if (hostingProfileRaw !== undefined) {
    const hostingProfile = parseHostingProfileId(hostingProfileRaw);
    if (!hostingProfile) {
      defaultRuntime.error(`Invalid --hosting-profile. Use ${formatHostingProfileIds()}.`);
      defaultRuntime.exit(1);
      return;
    }
    process.env[HOSTING_PROFILE_ENV] = hostingProfile;
  }
  const runtimeId = toOptionString(opts.runtimeId);
  if (runtimeId !== undefined) {
    process.env[RUNTIME_ID_ENV] = runtimeId;
  }
  const incarnationId = toOptionString(opts.incarnationId);
  if (incarnationId !== undefined) {
    process.env[INCARNATION_ID_ENV] = incarnationId;
  }
  try {
    resolveRuntimeActivationIdentity({ env: process.env });
  } catch (err) {
    defaultRuntime.error(formatErrorMessage(err));
    defaultRuntime.exit(1);
    return;
  }
  if (opts.cliBackendLogs || opts.claudeCliLogs) {
    setConsoleSubsystemFilter(["agent/cli-backend"]);
    process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT = "1";
  }
  const wsLogRaw = (opts.compact ? "compact" : opts.wsLog) as string | undefined;
  const wsLogStyle: GatewayWsLogStyle =
    wsLogRaw === "compact" ? "compact" : wsLogRaw === "full" ? "full" : "auto";
  if (
    wsLogRaw !== undefined &&
    wsLogRaw !== "auto" &&
    wsLogRaw !== "compact" &&
    wsLogRaw !== "full"
  ) {
    defaultRuntime.error('Invalid --ws-log. Use "auto", "full", or "compact".');
    defaultRuntime.exit(1);
  }
  setGatewayWsLogStyle(wsLogStyle);

  if (opts.rawStream) {
    process.env.OPENCLAW_RAW_STREAM = "1";
  }
  const rawStreamPath = toOptionString(opts.rawStreamPath);
  if (rawStreamPath) {
    process.env.OPENCLAW_RAW_STREAM_PATH = rawStreamPath;
  }

  const startupTrace = createGatewayCliStartupTrace();

  // The heaviest part of gateway startup is loading the server module tree
  // (channels, plugins, HTTP stack, etc.). Start it before the foreground TTY
  // banner so the animation never extends readiness. If loading wins, the
  // banner settles cleanly; otherwise its existing spinner owns the wait.
  const serverImportMeasurement = startupTrace.startMeasure(
    "cli.server-import",
    () => import("../../gateway/server.js"),
  );
  const rawServerImport = serverImportMeasurement.result;
  const bannerDone: Promise<ClawBannerResult> = process.stdout.isTTY
    ? printClawBanner(defaultRuntime, { settleWhen: rawServerImport })
    : Promise.resolve("static");
  const loadServerModule = async () => {
    try {
      const bannerResult = await bannerDone;
      return bannerResult === "settled"
        ? await rawServerImport
        : await withProgress(
            { label: "Loading gateway modules…", indeterminate: true },
            async () => rawServerImport,
          );
    } finally {
      // Trace output follows banner or spinner cleanup on both success and error.
      await serverImportMeasurement.settled;
      serverImportMeasurement.emit();
    }
  };
  const { startGatewayServer } = await loadServerModule();

  setConsoleTimestampPrefix(true);

  if (devMode) {
    if (opts.reset) {
      // Recheck immediately before full reset; gateway module loading above can take seconds.
      const { recheckGatewayRunReset } = await import("./pre-bootstrap.js");
      if (!(await recheckGatewayRunReset({ opts, runtime: defaultRuntime }))) {
        return;
      }
    }
    const { ensureDevGatewayConfig } = await import("./dev.js");
    await startupTrace.measure("cli.dev-config", () =>
      ensureDevGatewayConfig({ reset: Boolean(opts.reset) }),
    );
    if (opts.reset) {
      const { reloadTrustedGatewayRunEnvironment } = await import("./pre-bootstrap.js");
      if (!(await reloadTrustedGatewayRunEnvironment({ runtime: defaultRuntime }))) {
        return;
      }
    }
  }

  gatewayLog.info("loading configuration…");
  const { cfg, lowerPrecedenceEnv, snapshot, startupConfigSnapshotRead } =
    await readGatewayStartupConfigWithShellEnv({
      opts,
      startupTrace,
    });
  if (
    !enforceGatewayRunFutureConfigGuard({
      opts,
      runtime: defaultRuntime,
      snapshot,
    })
  ) {
    return;
  }
  if (snapshot) {
    const { applyFinalGatewayRunConfigEnv } = await import("./pre-bootstrap.js");
    if (
      !(await applyFinalGatewayRunConfigEnv({
        lowerPrecedenceEnv,
        runtime: defaultRuntime,
        snapshot,
      }))
    ) {
      return;
    }
    const finalConfigEnteredServiceMode = Boolean(process.env.OPENCLAW_SERVICE_MARKER?.trim());
    const clearRejectedFinalConfigEnv = () => {
      clearGatewayRunConfigEnvironment();
      if (finalConfigEnteredServiceMode) {
        delete process.env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
      }
    };
    let finalConfigAllowed: boolean;
    try {
      finalConfigAllowed = enforceGatewayRunFutureConfigGuard({
        opts,
        runtime: defaultRuntime,
        snapshot,
      });
    } catch (err) {
      clearRejectedFinalConfigEnv();
      throw err;
    }
    if (!finalConfigAllowed) {
      clearRejectedFinalConfigEnv();
      return;
    }
  }
  if (process.env.OPENCLAW_SERVICE_MARKER?.trim()) {
    process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV] = String(process.pid);
  }
  await hooks.refreshManagedProxy?.(cfg.proxy);
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    defaultRuntime.error(formatInvalidPortOption("--port"));
    defaultRuntime.exit(1);
    return;
  }
  const port = portOverride ?? resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
    defaultRuntime.error(formatInvalidConfigPort("gateway.port"));
    defaultRuntime.exit(EXIT_CONFIG_ERROR);
    return;
  }
  // Only capture the *explicit* bind value here.  The container-aware
  // default is deferred until after Tailscale mode is known (see below)
  // so that Tailscale's loopback constraint is respected.
  const VALID_BIND_MODES = new Set<string>(["loopback", "lan", "auto", "custom", "tailnet"]);
  const bindExplicitRawStr = normalizeOptionalString(
    toOptionString(opts.bind) ?? cfg.gateway?.bind,
  );
  if (bindExplicitRawStr !== undefined && !VALID_BIND_MODES.has(bindExplicitRawStr)) {
    defaultRuntime.error('Invalid --bind. Use "loopback", "lan", "tailnet", "auto", or "custom".');
    defaultRuntime.exit(1);
    return;
  }
  const bindExplicitRaw = bindExplicitRawStr as GatewayBindMode | undefined;
  if (process.env.OPENCLAW_SERVICE_MARKER?.trim()) {
    const { cleanStaleGatewayProcessesSync } = await import("../../infra/restart-stale-pids.js");
    const stale = cleanStaleGatewayProcessesSync(port, {
      protectedPid: inheritedGatewayServicePid,
    });
    if (stale.length > 0) {
      gatewayLog.info(
        `service-mode: cleared ${stale.length} stale gateway pid(s) before bind on port ${port}`,
      );
    }
  }
  if (opts.force) {
    const interactive = isTerminalInteractive();
    const describeNonInteractiveGatewayOwner = () => {
      const gatewayPids = findVerifiedGatewayListenerPidsOnPortSync(port);
      if (gatewayPids.length === 0) {
        return undefined;
      }
      return `${NON_INTERACTIVE_GATEWAY_RUN_FORCE_MESSAGE} Existing gateway listener pid${gatewayPids.length === 1 ? "" : "s"}: ${formatGatewayPidList(gatewayPids)}.`;
    };
    if (!interactive) {
      const refusal = describeNonInteractiveGatewayOwner();
      if (refusal) {
        defaultRuntime.error(refusal);
        defaultRuntime.exit(1);
        return;
      }
    }
    try {
      const { forceFreePortAndWait, waitForPortBindable } = await import("../ports.js");
      const { killed, waitedMs, escalatedToSigkill } = await forceFreePortAndWait(port, {
        timeoutMs: 2000,
        intervalMs: 100,
        sigtermTimeoutMs: 700,
        ...(interactive
          ? {}
          : {
              beforeSignal: () => {
                const refusal = describeNonInteractiveGatewayOwner();
                if (refusal) {
                  throw new Error(refusal);
                }
              },
            }),
      });
      if (killed.length === 0) {
        // Nothing was freed; keep the no-op out of normal startup output.
        gatewayLog.debug(`force: no listeners on port ${port}`);
      } else {
        for (const proc of killed) {
          gatewayLog.info(
            `force: killed pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""} on port ${port}`,
          );
        }
        if (escalatedToSigkill) {
          gatewayLog.info(`force: escalated to SIGKILL while freeing port ${port}`);
        }
        if (waitedMs > 0) {
          gatewayLog.info(`force: waited ${waitedMs}ms for port ${port} to free`);
        }
      }
      // After killing, verify the port is actually bindable (handles TIME_WAIT).
      const bindProbeHost =
        bindExplicitRaw === "loopback"
          ? "127.0.0.1"
          : bindExplicitRaw === "lan"
            ? "0.0.0.0"
            : bindExplicitRaw === "custom"
              ? toOptionString(cfg.gateway?.customBindHost)
              : undefined;
      const bindWaitMs = await waitForPortBindable(port, {
        timeoutMs: 3000,
        intervalMs: 150,
        host: bindProbeHost,
      });
      if (bindWaitMs > 0) {
        gatewayLog.info(`force: waited ${bindWaitMs}ms for port ${port} to become bindable`);
      }
    } catch (err) {
      defaultRuntime.error(
        `Could not free port ${port}: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} to inspect the listener.`,
      );
      defaultRuntime.exit(1);
      return;
    }
  }
  if (opts.token) {
    const token = toOptionString(opts.token);
    if (token) {
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
    }
  }
  const authModeRaw = toOptionString(opts.auth);
  const authMode = parseEnumOption(authModeRaw, GATEWAY_AUTH_MODES);
  if (authModeRaw && !authMode) {
    defaultRuntime.error(`Invalid --auth. Use ${formatModeErrorList(GATEWAY_AUTH_MODES)}.`);
    defaultRuntime.exit(1);
    return;
  }
  const tailscaleRaw = toOptionString(opts.tailscale);
  const tailscaleMode = parseEnumOption(tailscaleRaw, GATEWAY_TAILSCALE_MODES);
  if (tailscaleRaw && !tailscaleMode) {
    defaultRuntime.error(
      `Invalid --tailscale. Use ${formatModeErrorList(GATEWAY_TAILSCALE_MODES)}.`,
    );
    defaultRuntime.exit(1);
    return;
  }
  // Now that Tailscale mode is known, compute the effective bind mode.
  const effectiveTailscaleMode = tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off";
  const bind = (bindExplicitRaw ?? defaultGatewayBindMode(effectiveTailscaleMode)) as
    | "loopback"
    | "lan"
    | "auto"
    | "custom"
    | "tailnet";

  let passwordRaw: string | undefined;
  try {
    passwordRaw = await resolveGatewayPasswordOption(opts);
  } catch (err) {
    defaultRuntime.error(formatErrorMessage(err));
    defaultRuntime.exit(1);
    return;
  }
  if (toOptionString(opts.password)) {
    warnInlinePasswordFlag();
  }
  const tokenRaw = toOptionString(opts.token);

  gatewayLog.info("resolving authentication…");
  const configExists = snapshot?.exists ?? fs.existsSync(CONFIG_PATH);
  const effectiveCfg = snapshot?.valid ? snapshot.config : cfg;
  const mode = effectiveCfg.gateway?.mode;
  const guardErrors = getGatewayStartGuardErrors({
    allowUnconfigured: opts.allowUnconfigured,
    configExists,
    configAuditLocation: CONFIG_AUDIT_STORE_LABEL,
    mode,
  });
  if (guardErrors.length > 0) {
    for (const error of guardErrors) {
      defaultRuntime.error(error);
    }
    defaultRuntime.exit(EXIT_CONFIG_ERROR);
    return;
  }
  const miskeys = extractGatewayMiskeys(snapshot?.parsed);
  const authOverride =
    authMode || passwordRaw || tokenRaw || authModeRaw
      ? {
          ...(authMode ? { mode: authMode } : {}),
          ...(tokenRaw ? { token: tokenRaw } : {}),
          ...(passwordRaw ? { password: passwordRaw } : {}),
        }
      : undefined;
  const { resolveGatewayAuth } = await import("../../gateway/auth.js");
  const resolvedAuth = await startupTrace.measure("cli.auth-resolve", () =>
    resolveGatewayAuth({
      authConfig: cfg.gateway?.auth,
      authOverride,
      env: process.env,
      tailscaleMode: tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off",
    }),
  );
  const resolvedAuthMode = resolvedAuth.mode;
  const tokenValue = resolvedAuth.token;
  const passwordValue = resolvedAuth.password;
  const hasToken = typeof tokenValue === "string" && tokenValue.trim().length > 0;
  const hasPassword = typeof passwordValue === "string" && passwordValue.trim().length > 0;
  const tokenConfigured =
    hasToken ||
    hasConfiguredSecretInput(
      authOverride?.token ?? cfg.gateway?.auth?.token,
      cfg.secrets?.defaults,
    );
  const passwordConfigured =
    hasPassword ||
    hasConfiguredSecretInput(
      authOverride?.password ?? cfg.gateway?.auth?.password,
      cfg.secrets?.defaults,
    );
  const hasSharedSecret =
    (resolvedAuthMode === "token" && tokenConfigured) ||
    (resolvedAuthMode === "password" && passwordConfigured);
  const authHints: string[] = [];
  if (miskeys.hasGatewayToken) {
    authHints.push('Found "gateway.token" in config. Use "gateway.auth.token" instead.');
  }
  if (miskeys.hasRemoteToken) {
    authHints.push(
      '"gateway.remote.token" is for remote CLI calls; it does not enable local gateway auth.',
    );
  }
  if (resolvedAuthMode === "password" && !passwordConfigured) {
    defaultRuntime.error(
      [
        "Gateway auth is set to password, but no password is configured.",
        "Set gateway.auth.password (or OPENCLAW_GATEWAY_PASSWORD), or pass --password.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(EXIT_CONFIG_ERROR);
    return;
  }
  if (resolvedAuthMode === "none") {
    gatewayLog.warn(
      "Gateway auth mode=none explicitly configured; all gateway connections are unauthenticated.",
    );
  }
  const healthHost = await resolveGatewayBindHost(bind, cfg.gateway?.customBindHost);
  if (
    shouldBlockGatewayBindWithoutExplicitAuth({
      bindHost: healthHost,
      hasSharedSecret,
      resolvedAuthMode,
    })
  ) {
    defaultRuntime.error(
      [
        `Refusing to bind gateway to ${bind} without auth.`,
        ...(isContainerEnvironment()
          ? [
              "Container environment detected \u2014 the gateway defaults to bind=auto (0.0.0.0) for port-forwarding compatibility.",
              "Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD, or pass --token/--password to start with auth.",
            ]
          : [
              "Set gateway.auth.token/password (or OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD) or pass --token/--password.",
            ]),
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(EXIT_CONFIG_ERROR);
    return;
  }
  const tailscaleOverride =
    tailscaleMode || opts.tailscaleResetOnExit
      ? {
          ...(tailscaleMode ? { mode: tailscaleMode } : {}),
          ...(opts.tailscaleResetOnExit ? { resetOnExit: true } : {}),
        }
      : undefined;

  gatewayLog.info("starting...");
  startupTrace.mark("cli.gateway-loop");
  let startupConfigSnapshotReadForNextStart = startupConfigSnapshotRead;
  const envSidecarStartupMode =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS)
      ? "defer"
      : "start";
  let crashLoopDecision: GatewayCrashLoopBreakerDecision | undefined;
  let channelAutostartSuppression: { reason: "crash-loop-breaker"; message: string } | undefined;
  let activeBootId: string | undefined;
  const beginBoot = async (startedAtMs: number) => {
    // run-loop calls beginBoot before every startGatewayServer invocation, so
    // in-process restarts re-evaluate breaker state instead of reusing stale mode.
    crashLoopDecision = inspectGatewayCrashLoopBreaker(process.env, startedAtMs);
    const bootStartReason = crashLoopDecision.tripped
      ? crashLoopDecision.shouldWriteStabilityBundle
        ? GATEWAY_CRASH_LOOP_BREAKER_REASON
        : undefined
      : crashLoopDecision.recovered
        ? GATEWAY_CRASH_LOOP_RECOVERED_REASON
        : undefined;
    activeBootId = recordGatewayBootStart(process.env, startedAtMs, bootStartReason);
    channelAutostartSuppression = undefined;
    if (crashLoopDecision.recovered) {
      gatewayLog.info("gateway restart-loop breaker recovered; channel auto-start restored");
    }
    if (!crashLoopDecision.tripped) {
      return;
    }
    const message =
      `gateway restart-loop breaker tripped: ${crashLoopDecision.uncleanBoots} unclean boot(s) within ${crashLoopDecision.windowMs}ms; ` +
      "suppressing channel/provider account auto-start. Inspect the stability bundle and fix the startup crash before restarting the service.";
    channelAutostartSuppression = { reason: "crash-loop-breaker", message };
    gatewayLog.error(message);
    if (crashLoopDecision.shouldWriteStabilityBundle) {
      await maybeWriteGatewayStartupFailureBundle(
        new Error(message),
        GATEWAY_CRASH_LOOP_BREAKER_REASON,
      );
    }
  };
  const completeBoot = (completion: GatewayBootLifecycleCompletion) => {
    completeGatewayBootLifecycle(activeBootId, completion, process.env);
    activeBootId = undefined;
  };
  const startLoop = async () =>
    await runGatewayLoop({
      runtime: defaultRuntime,
      lockPort: port,
      healthHost,
      beginBoot,
      completeBoot,
      start: async ({ startupStartedAt, requestHotReloadRecovery } = {}) => {
        const startupConfigSnapshotReadForThisStart = startupConfigSnapshotReadForNextStart;
        startupConfigSnapshotReadForNextStart = undefined;
        return await startGatewayServer(port, {
          bind,
          auth: authOverride,
          tailscale: tailscaleOverride,
          startupStartedAt,
          ...(requestHotReloadRecovery ? { hotReloadRecovery: requestHotReloadRecovery } : {}),
          ...(startupConfigSnapshotReadForThisStart
            ? { startupConfigSnapshotRead: startupConfigSnapshotReadForThisStart }
            : {}),
          ...(envSidecarStartupMode !== "start" ? { sidecarStartup: envSidecarStartupMode } : {}),
          ...(channelAutostartSuppression ? { channelAutostartSuppression } : {}),
          ...(devMode
            ? {
                ambientEnvTriggers: devAmbientEnvTriggers,
              }
            : {}),
        });
      },
    });

  const { detectRespawnSupervisor } = await import("../../infra/supervisor-markers.js");
  const supervisor = detectRespawnSupervisor(process.env);
  try {
    await runGatewayLoopWithSupervisedLockRecovery({
      startLoop,
      supervisor,
      port,
      healthHost,
      log: gatewayLog,
      probeHealth: createConfiguredGatewayHealthProbe(cfg),
    });
  } catch (err) {
    if (isGatewayLockError(err)) {
      const errMessage = formatErrorMessage(err);
      defaultRuntime.error(
        `Gateway failed to start: ${errMessage}\nIf the gateway is supervised, stop it with: ${formatCliCommand("openclaw gateway stop")}`,
      );
      try {
        const { formatPortDiagnostics, inspectPortUsage } = await import("../../infra/ports.js");
        const diagnostics = await inspectPortUsage(port);
        if (diagnostics.status === "busy") {
          for (const line of formatPortDiagnostics(diagnostics)) {
            defaultRuntime.error(line);
          }
        }
      } catch {
        // ignore diagnostics failures
      }
      const { maybeExplainGatewayServiceStop } = await import("./shared.js");
      await maybeExplainGatewayServiceStop();
      defaultRuntime.exit(resolveGatewayLockErrorExitCode(err));
      return;
    }
    if (isInvalidConfigError(err)) {
      throw err;
    }
    await maybeWriteGatewayStartupFailureBundle(err);
    defaultRuntime.error(
      `Gateway failed to start: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} for diagnostics.`,
    );
    defaultRuntime.exit(resolveGatewayStartupFailureExitCode(err));
  }
}

/** Run foreground Gateway startup with one consent-gated invalid-config repair attempt. */
export async function runGatewayCommand(
  opts: GatewayRunOpts,
  hooks: GatewayRunRuntimeHooks = {},
  recoveryDeps?: InvalidConfigRecoveryDeps,
) {
  try {
    await runGatewayCommandOnce(opts, hooks);
  } catch (error) {
    if (!isInvalidConfigError(error)) {
      throw error;
    }
    defaultRuntime.error(`Gateway failed to start: ${formatErrorMessage(error)}`);
    if (opts.allowUnconfigured || !isDoctorRecoverableInvalidConfigError(error)) {
      defaultRuntime.exit(EXIT_CONFIG_ERROR);
      return;
    }
    const { offerInvalidConfigRecovery } = await import("../invalid-config-recovery.js");
    const recovery = await offerInvalidConfigRecovery({
      runtime: defaultRuntime,
      deps: recoveryDeps,
      retry: async () => await runGatewayCommandOnce(opts, hooks),
    });
    if (recovery.status === "recovered") {
      return;
    }
    defaultRuntime.exit(EXIT_CONFIG_ERROR);
  }
}

const testing = {
  createConfiguredGatewayHealthProbe,
  isGatewayHealthzResponse,
  normalizeGatewayHealthProbeHost,
  probeGatewayHealthz,
  resolveGatewayLockErrorExitCode,
  resolveGatewayStartupFailureExitCode,
  runGatewayLoopWithSupervisedLockRecovery,
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.gatewayRunTestApi")] = testing;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
