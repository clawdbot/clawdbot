import fs from "node:fs";
import { request } from "node:http";
import path from "node:path";
import type { Command } from "commander";
import type {
  ConfigFileSnapshot,
  GatewayAuthMode,
  GatewayBindMode,
  GatewayTailscaleMode,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "../../config/config.js";
import { formatConfigIssueSummary } from "../../config/issue-format.js";
import { CONFIG_PATH, resolveGatewayPort, resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import {
  defaultGatewayBindMode,
  isContainerEnvironment,
  resolveGatewayBindHost,
} from "../../gateway/net.js";
import type { GatewayWsLogStyle } from "../../gateway/ws-logging.js";
import { setGatewayWsLogStyle } from "../../gateway/ws-logging.js";
import { setVerbose } from "../../globals.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import { setConsoleSubsystemFilter, setConsoleTimestampPrefix } from "../../logging/console.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { formatCliCommand } from "../command-format.js";
import { inheritOptionFromParent } from "../command-options.js";
import { withProgress } from "../progress.js";
import { parsePort } from "../shared/parse-port.js";
import { installQaParentWatchdog } from "./qa-parent-watchdog.js";
import { runGatewayLoop } from "./run-loop.js";

type GatewayRunOpts = {
  port?: unknown;
  bind?: unknown;
  token?: unknown;
  auth?: unknown;
  password?: unknown;
  passwordFile?: unknown;
  tailscale?: unknown;
  tailscaleResetOnExit?: boolean;
  allowUnconfigured?: boolean;
  force?: boolean;
  verbose?: boolean;
  cliBackendLogs?: boolean;
  /** @deprecated Use cliBackendLogs. */
  claudeCliLogs?: boolean;
  wsLog?: unknown;
  compact?: boolean;
  rawStream?: boolean;
  rawStreamPath?: unknown;
  dev?: boolean;
  reset?: boolean;
};

const gatewayLog = createSubsystemLogger("gateway");

const GATEWAY_RUN_VALUE_KEYS = [
  "port",
  "bind",
  "token",
  "auth",
  "password",
  "passwordFile",
  "tailscale",
  "wsLog",
  "rawStreamPath",
] as const;

const GATEWAY_RUN_BOOLEAN_KEYS = [
  "tailscaleResetOnExit",
  "allowUnconfigured",
  "dev",
  "reset",
  "force",
  "verbose",
  "cliBackendLogs",
  "claudeCliLogs",
  "compact",
  "rawStream",
] as const;

const SUPERVISED_GATEWAY_LOCK_RETRY_MS = 5000;
const SUPERVISED_GATEWAY_LOCK_RETRY_TIMEOUT_MS = 30_000;
const SUPERVISED_GATEWAY_HEALTH_PROBE_TIMEOUT_MS = 1000;

type Awaitable<T> = T | Promise<T>;
type GatewayRunLogger = Pick<ReturnType<typeof createSubsystemLogger>, "info" | "warn">;

/**
 * EX_CONFIG (78) from sysexits.h — used for configuration errors so systemd
 * (via RestartPreventExitStatus=78) stops restarting instead of entering a
 * restart storm that can render low-resource hosts unresponsive.
 */
const EXIT_CONFIG_ERROR = 78;
const CONFIG_AUTO_RECOVERY_MESSAGE =
  "Gateway recovered automatically after a failed config change and restored the last known good configuration.";

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
  return {
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
    },
    async measure<T>(name: string, run: () => Awaitable<T>): Promise<T> {
      const before = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        emit(name, now - before, now - started);
        last = now;
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

function formatModeChoices(modes: readonly string[]): string {
  return modes.map((mode) => `"${mode}"`).join("|");
}

function formatModeErrorList(modes: readonly string[]): string {
  const quoted = modes.map((mode) => `"${mode}"`);
  if (quoted.length === 0) {
    return "";
  }
  if (quoted.length === 1) {
    return quoted[0];
  }
  if (quoted.length === 2) {
    return `${quoted[0]} or ${quoted[1]}`;
  }
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

async function maybeLogPendingControlUiBuild(cfg: OpenClawConfig): Promise<void> {
  if (cfg.gateway?.controlUi?.enabled === false) {
    return;
  }
  if (toOptionString(cfg.gateway?.controlUi?.root)) {
    return;
  }
  const { resolveControlUiRootSync } = await import("../../infra/control-ui-assets.js");
  if (
    resolveControlUiRootSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })
  ) {
    return;
  }
  gatewayLog.info(
    "Control UI assets are missing; first startup may spend a few seconds building them before the gateway binds. `pnpm gateway:watch` does not rebuild Control UI assets, so rerun `pnpm ui:build` after UI changes or use `pnpm ui:dev` while developing the Control UI. For a full local dist, run `pnpm build && pnpm ui:build`.",
  );
}

function getGatewayStartGuardErrors(params: {
  allowUnconfigured?: boolean;
  configExists: boolean;
  configAuditPath: string;
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
      `Config write audit: ${params.configAuditPath}`,
    ];
  }
  return [
    `Gateway start blocked: set gateway.mode=local (current: ${params.mode}) or pass --allow-unconfigured.`,
    `Config write audit: ${params.configAuditPath}`,
  ];
}

async function readGatewayStartupConfig(params: {
  startupTrace: ReturnType<typeof createGatewayCliStartupTrace>;
}): Promise<{
  cfg: OpenClawConfig;
  snapshot: ConfigFileSnapshot | null;
  startupConfigSnapshotRead?: ReadConfigFileSnapshotWithPluginMetadataResult;
}> {
  const {
    readConfigFileSnapshotWithPluginMetadata,
    recoverConfigFromLastKnownGood,
    recoverConfigFromJsonRootSuffix,
  } = await import("../../config/config.js");
  let snapshotRead: ReadConfigFileSnapshotWithPluginMetadataResult | null =
    await params.startupTrace.measure("cli.config-snapshot", () =>
      readConfigFileSnapshotWithPluginMetadata().catch(() => null),
    );
  let snapshot: ConfigFileSnapshot | null = snapshotRead?.snapshot ?? null;
  if (snapshot?.exists && !snapshot.valid) {
    const invalidSnapshot = snapshot;
    const recovered = await params.startupTrace.measure("cli.config-recovery", () =>
      recoverConfigFromLastKnownGood({
        snapshot: invalidSnapshot,
        reason: "gateway-run-invalid-config",
      }),
    );
    if (recovered) {
      const issueSummary = formatConfigIssueSummary([
        ...invalidSnapshot.issues,
        ...invalidSnapshot.legacyIssues,
      ]);
      gatewayLog.warn(
        `gateway: restored invalid effective config from last-known-good backup: ${invalidSnapshot.path}${issueSummary ? `; Rejected validation details: ${issueSummary}.` : ""}`,
      );
      try {
        const { writeRestartSentinel } = await import("../../infra/restart-sentinel.js");
        await writeRestartSentinel({
          kind: "config-auto-recovery",
          status: "ok",
          ts: Date.now(),
          message: CONFIG_AUTO_RECOVERY_MESSAGE,
          stats: {
            mode: "config-auto-recovery",
            reason: "gateway-run-invalid-config",
            after: { restoredFrom: "last-known-good" },
          },
        });
      } catch (err) {
        gatewayLog.warn(
          `gateway: failed to persist config auto-recovery notice: ${formatErrorMessage(err)}`,
        );
      }
      snapshotRead = await params.startupTrace.measure("cli.config-snapshot-reload", () =>
        readConfigFileSnapshotWithPluginMetadata().catch(() => null),
      );
      snapshot = snapshotRead?.snapshot ?? null;
    } else {
      const repaired = await params.startupTrace.measure("cli.config-prefix-recovery", () =>
        recoverConfigFromJsonRootSuffix(invalidSnapshot),
      );
      if (repaired) {
        gatewayLog.warn(
          `gateway: repaired invalid effective config by stripping a non-JSON prefix: ${invalidSnapshot.path}`,
        );
        snapshotRead = await params.startupTrace.measure("cli.config-snapshot-reload", () =>
          readConfigFileSnapshotWithPluginMetadata().catch(() => null),
        );
        snapshot = snapshotRead?.snapshot ?? null;
      }
    }
  }
  const cfg = snapshot?.config ?? {};
  return {
    cfg,
    snapshot,
    ...(snapshotRead ? { startupConfigSnapshotRead: snapshotRead } : {}),
  };
}

function resolveGatewayRunOptions(opts: GatewayRunOpts, command?: Command): GatewayRunOpts {
  const resolved: GatewayRunOpts = { ...opts };

  for (const key of GATEWAY_RUN_VALUE_KEYS) {
    const inherited = inheritOptionFromParent(command, key);
    if (key === "wsLog") {
      // wsLog has a child default ("auto"), so prefer inherited parent CLI value when present.
      resolved[key] = inherited ?? resolved[key];
      continue;
    }
    resolved[key] = resolved[key] ?? inherited;
  }

  for (const key of GATEWAY_RUN_BOOLEAN_KEYS) {
    const inherited = inheritOptionFromParent<boolean>(command, key);
    resolved[key] = Boolean(resolved[key] || inherited);
  }

  return resolved;
}

function isGatewayLockError(err: unknown): err is GatewayLockError {
  return (
    err instanceof GatewayLockError ||
    (!!err && typeof err === "object" && (err as { name?: string }).name === "GatewayLockError")
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

function isHealthyGatewayLockError(err: unknown): boolean {
  return isGatewayAlreadyRunningLockError(err);
}

function resolveGatewayLockErrorExitCode(
  err: unknown,
  supervisor: RespawnSupervisor | null,
): number {
  if (supervisor === "systemd" && isGatewayAlreadyRunningLockError(err)) {
    return EXIT_CONFIG_ERROR;
  }
  return isHealthyGatewayLockError(err) ? 0 : 1;
}

function normalizeGatewayHealthProbeHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }
  return host;
}

async function probeGatewayHealthz(params: {
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<boolean> {
  const timeoutMs = params.timeoutMs ?? SUPERVISED_GATEWAY_HEALTH_PROBE_TIMEOUT_MS;
  return await new Promise<boolean>((resolve) => {
    const req = request(
      {
        hostname: normalizeGatewayHealthProbeHost(params.host),
        port: params.port,
        path: "/healthz",
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(typeof res.statusCode === "number" && res.statusCode < 500);
      },
    );
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.once("error", () => {
      resolve(false);
    });
    req.end();
  });
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
    params.sleep ?? (async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)));
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
          throw new GatewayLockError(
            "gateway already running under systemd; existing gateway is healthy, exiting with code 78 to prevent a systemd Restart=always loop",
            err,
          );
        }
        params.log.info(
          `gateway already running under ${supervisor}; existing gateway is healthy, leaving it in control`,
        );
        return;
      }

      const elapsedMs = now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        throw new GatewayLockError(
          `gateway already running under ${supervisor}; existing gateway did not become healthy after ${timeoutMs}ms`,
          err,
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

async function maybeWriteGatewayStartupFailureBundle(err: unknown): Promise<void> {
  const { writeDiagnosticStabilityBundleForFailureSync } =
    await import("../../logging/diagnostic-stability-bundle.js");
  const result = writeDiagnosticStabilityBundleForFailureSync("gateway.startup_failed", err);
  if ("message" in result) {
    gatewayLog.warn(result.message);
  }
}

async function runGatewayCommand(opts: GatewayRunOpts) {
  installQaParentWatchdog();
  const isDevProfile = normalizeOptionalLowercaseString(process.env.OPENCLAW_PROFILE) === "dev";
  const devMode = Boolean(opts.dev) || isDevProfile;
  if (opts.reset && !devMode) {
    defaultRuntime.error("Use --reset with --dev.");
    defaultRuntime.exit(1);
    return;
  }

  setVerbose(Boolean(opts.verbose));
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
    defaultRuntime.error('Invalid --ws-log (use "auto", "full", "compact")');
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
  // (channels, plugins, HTTP stack, etc.). Show a spinner so the user sees
  // progress instead of a silent 15-20 s pause (especially on Windows/NTFS).
  const { startGatewayServer } = await startupTrace.measure("cli.server-import", () =>
    withProgress(
      { label: "Loading gateway modules…", indeterminate: true },
      async () => import("../../gateway/server.js"),
    ),
  );

  setConsoleTimestampPrefix(true);

  if (devMode) {
    const { ensureDevGatewayConfig } = await import("./dev.js");
    await startupTrace.measure("cli.dev-config", () =>
      ensureDevGatewayConfig({ reset: Boolean(opts.reset) }),
    );
  }

  gatewayLog.info("loading configuration…");
  const { cfg, snapshot, startupConfigSnapshotRead } = await readGatewayStartupConfig({
    startupTrace,
  });
  void maybeLogPendingControlUiBuild(cfg).catch((err) => {
    gatewayLog.warn(`Control UI asset check failed: ${String(err)}`);
  });
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
  }
  const port = portOverride ?? resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
  }
  const { formatFutureConfigActionBlock, resolveFutureConfigActionBlock } =
    await import("../../config/future-version-guard.js");
  const futureStartupBlock = resolveFutureConfigActionBlock({
    action: "start the gateway service",
    snapshot,
  });
  if (futureStartupBlock && process.env.OPENCLAW_SERVICE_MARKER?.trim()) {
    defaultRuntime.error(formatFutureConfigActionBlock(futureStartupBlock));
    defaultRuntime.exit(78);
    return;
  }
  const futureForceBlock = opts.force
    ? resolveFutureConfigActionBlock({
        action: "force-kill gateway port listeners",
        snapshot,
      })
    : null;
  if (futureForceBlock) {
    defaultRuntime.error(formatFutureConfigActionBlock(futureForceBlock));
    defaultRuntime.exit(1);
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
    defaultRuntime.error('Invalid --bind (use "loopback", "lan", "tailnet", "auto", or "custom")');
    defaultRuntime.exit(1);
    return;
  }
  const bindExplicitRaw = bindExplicitRawStr as GatewayBindMode | undefined;
  if (process.env.OPENCLAW_SERVICE_MARKER?.trim()) {
    const { cleanStaleGatewayProcessesSync } = await import("../../infra/restart-stale-pids.js");
    const stale = cleanStaleGatewayProcessesSync(port);
    if (stale.length > 0) {
      gatewayLog.info(
        `service-mode: cleared ${stale.length} stale gateway pid(s) before bind on port ${port}`,
      );
    }
  }
  if (opts.force) {
    try {
      const { forceFreePortAndWait, waitForPortBindable } = await import("../ports.js");
      const { killed, waitedMs, escalatedToSigkill } = await forceFreePortAndWait(port, {
        timeoutMs: 2000,
        intervalMs: 100,
        sigtermTimeoutMs: 700,
      });
      if (killed.length === 0) {
        gatewayLog.info(`force: no listeners on port ${port}`);
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
      defaultRuntime.error(`Force: ${String(err)}`);
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
    defaultRuntime.error(`Invalid --auth (use ${formatModeErrorList(GATEWAY_AUTH_MODES)})`);
    defaultRuntime.exit(1);
    return;
  }
  const tailscaleRaw = toOptionString(opts.tailscale);
  const tailscaleMode = parseEnumOption(tailscaleRaw, GATEWAY_TAILSCALE_MODES);
  if (tailscaleRaw && !tailscaleMode) {
    defaultRuntime.error(
      `Invalid --tailscale (use ${formatModeErrorList(GATEWAY_TAILSCALE_MODES)})`,
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
  const configAuditPath = path.join(resolveStateDir(process.env), "logs", "config-audit.jsonl");
  const effectiveCfg = snapshot?.valid ? snapshot.config : cfg;
  const mode = effectiveCfg.gateway?.mode;
  const guardErrors = getGatewayStartGuardErrors({
    allowUnconfigured: opts.allowUnconfigured,
    configExists,
    configAuditPath,
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
  const canBootstrapToken = resolvedAuthMode === "token" && !tokenConfigured;
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
  if (
    bind !== "loopback" &&
    !hasSharedSecret &&
    !canBootstrapToken &&
    resolvedAuthMode !== "trusted-proxy"
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
  const healthHost = await resolveGatewayBindHost(bind, cfg.gateway?.customBindHost);
  const startLoop = async () =>
    await runGatewayLoop({
      runtime: defaultRuntime,
      lockPort: port,
      healthHost,
      start: async ({ startupStartedAt } = {}) =>
        await startGatewayServer(port, {
          bind,
          auth: authOverride,
          tailscale: tailscaleOverride,
          startupStartedAt,
          ...(startupConfigSnapshotRead ? { startupConfigSnapshotRead } : {}),
        }),
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
      defaultRuntime.exit(resolveGatewayLockErrorExitCode(err, supervisor));
      return;
    }
    await maybeWriteGatewayStartupFailureBundle(err);
    defaultRuntime.error(`Gateway failed to start: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

export const __testing = {
  normalizeGatewayHealthProbeHost,
  resolveGatewayLockErrorExitCode,
  runGatewayLoopWithSupervisedLockRecovery,
};

export function addGatewayRunCommand(cmd: Command): Command {
  return cmd
    .option("--port <port>", "Port for the gateway WebSocket")
    .option(
      "--bind <mode>",
      'Bind mode ("loopback"|"lan"|"tailnet"|"auto"|"custom"). Defaults to config gateway.bind (or loopback).',
    )
    .option(
      "--token <token>",
      "Shared token required in connect.params.auth.token (default: OPENCLAW_GATEWAY_TOKEN env if set)",
    )
    .option("--auth <mode>", `Gateway auth mode (${formatModeChoices(GATEWAY_AUTH_MODES)})`)
    .option("--password <password>", "Password for auth mode=password")
    .option("--password-file <path>", "Read gateway password from file")
    .option(
      "--tailscale <mode>",
      `Tailscale exposure mode (${formatModeChoices(GATEWAY_TAILSCALE_MODES)})`,
    )
    .option(
      "--tailscale-reset-on-exit",
      "Reset Tailscale serve/funnel configuration on shutdown",
      false,
    )
    .option(
      "--allow-unconfigured",
      "Allow gateway start without enforcing gateway.mode=local in config (does not repair config)",
      false,
    )
    .option("--dev", "Create a dev config + workspace if missing (no BOOTSTRAP.md)", false)
    .option(
      "--reset",
      "Reset dev config + credentials + sessions + workspace (requires --dev)",
      false,
    )
    .option("--force", "Kill any existing listener on the target port before starting", false)
    .option("--verbose", "Verbose logging to stdout/stderr", false)
    .option(
      "--cli-backend-logs",
      "Only show CLI backend logs in the console (includes stdout/stderr)",
      false,
    )
    .option("--claude-cli-logs", "Deprecated alias for --cli-backend-logs", false)
    .option("--ws-log <style>", 'WebSocket log style ("auto"|"full"|"compact")', "auto")
    .option("--compact", 'Alias for "--ws-log compact"', false)
    .option("--raw-stream", "Log raw model stream events to jsonl", false)
    .option("--raw-stream-path <path>", "Raw stream jsonl path")
    .action(async (opts, command) => {
      await runGatewayCommand(resolveGatewayRunOptions(opts, command));
    });
}
