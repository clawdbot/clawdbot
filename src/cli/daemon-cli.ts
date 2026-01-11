import path from "node:path";
import type { Command } from "commander";

import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../commands/daemon-runtime.js";
import { resolveControlUiLinks } from "../commands/onboard-helpers.js";
import {
  createConfigIO,
  loadConfig,
  resolveConfigPath,
  resolveGatewayPort,
  resolveStateDir,
} from "../config/config.js";
import { resolveIsNixMode } from "../config/paths.js";
import type {
  BridgeBindMode,
  GatewayControlUiConfig,
} from "../config/types.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import {
  type FindExtraGatewayServicesOptions,
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
} from "../daemon/inspect.js";
import { resolveGatewayLogPaths } from "../daemon/launchd.js";
import { findLegacyGatewayServices } from "../daemon/legacy.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { ServiceConfigAudit } from "../daemon/service-audit.js";
import { auditGatewayServiceConfig } from "../daemon/service-audit.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import { callGateway } from "../gateway/call.js";
import { resolveGatewayBindHost } from "../gateway/net.js";
import {
  formatPortDiagnostics,
  inspectPortUsage,
  type PortListener,
  type PortUsageStatus,
} from "../infra/ports.js";
import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import { getResolvedLoggerSettings } from "../logging.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-provider.js";
import { createDefaultDeps } from "./deps.js";
import { withProgress } from "./progress.js";

type ConfigSummary = {
  path: string;
  exists: boolean;
  valid: boolean;
  issues?: Array<{ path: string; message: string }>;
  controlUi?: GatewayControlUiConfig;
};

type GatewayStatusSummary = {
  bindMode: BridgeBindMode;
  bindHost: string | null;
  port: number;
  portSource: "service args" | "env/config";
  probeUrl: string;
  probeNote?: string;
};

type DaemonStatus = {
  service: {
    label: string;
    loaded: boolean;
    loadedText: string;
    notLoadedText: string;
    command?: {
      programArguments: string[];
      workingDirectory?: string;
      environment?: Record<string, string>;
      sourcePath?: string;
    } | null;
    runtime?: {
      status?: string;
      state?: string;
      subState?: string;
      pid?: number;
      lastExitStatus?: number;
      lastExitReason?: string;
      lastRunResult?: string;
      lastRunTime?: string;
      detail?: string;
      cachedLabel?: boolean;
      missingUnit?: boolean;
    };
    configAudit?: ServiceConfigAudit;
  };
  config?: {
    cli: ConfigSummary;
    daemon?: ConfigSummary;
    mismatch?: boolean;
  };
  gateway?: GatewayStatusSummary;
  port?: {
    port: number;
    status: PortUsageStatus;
    listeners: PortListener[];
    hints: string[];
  };
  portCli?: {
    port: number;
    status: PortUsageStatus;
    listeners: PortListener[];
    hints: string[];
  };
  lastError?: string;
  rpc?: {
    ok: boolean;
    error?: string;
    url?: string;
  };
  legacyServices: Array<{ label: string; detail: string }>;
  extraServices: Array<{ label: string; detail: string; scope: string }>;
};

export type GatewayRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
};

export type DaemonStatusOptions = {
  rpc: GatewayRpcOpts;
  probe: boolean;
  json: boolean;
} & FindExtraGatewayServicesOptions;

export type DaemonInstallOptions = {
  port?: string | number;
  runtime?: string;
  token?: string;
  force?: boolean;
};

function parsePort(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const value =
    typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "bigint"
        ? raw.toString()
        : null;
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parsePortFromArgs(
  programArguments: string[] | undefined,
): number | null {
  if (!programArguments?.length) return null;
  for (let i = 0; i < programArguments.length; i += 1) {
    const arg = programArguments[i];
    if (arg === "--port") {
      const next = programArguments[i + 1];
      const parsed = parsePort(next);
      if (parsed) return parsed;
    }
    if (arg?.startsWith("--port=")) {
      const parsed = parsePort(arg.split("=", 2)[1]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function pickProbeHostForBind(
  bindMode: string,
  tailnetIPv4: string | undefined,
) {
  if (bindMode === "tailnet") return tailnetIPv4 ?? "127.0.0.1";
  if (bindMode === "auto") return tailnetIPv4 ?? "127.0.0.1";
  return "127.0.0.1";
}

function safeDaemonEnv(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const allow = [
    "CLAWDBOT_PROFILE",
    "CLAWDBOT_STATE_DIR",
    "CLAWDBOT_CONFIG_PATH",
    "CLAWDBOT_GATEWAY_PORT",
    "CLAWDBOT_NIX_MODE",
  ];
  const lines: string[] = [];
  for (const key of allow) {
    const value = env[key];
    if (!value?.trim()) continue;
    lines.push(`${key}=${value.trim()}`);
  }
  return lines;
}

function normalizeListenerAddress(raw: string): string {
  let value = raw.trim();
  if (!value) return value;
  value = value.replace(/^TCP\s+/i, "");
  value = value.replace(/\s+\(LISTEN\)\s*$/i, "");
  return value.trim();
}

async function probeGatewayStatus(opts: {
  url: string;
  token?: string;
  password?: string;
  timeoutMs: number;
  json?: boolean;
  configPath?: string;
}) {
  try {
    await withProgress(
      {
        label: "Checking gateway status...",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway({
          url: opts.url,
          token: opts.token,
          password: opts.password,
          method: "status",
          timeoutMs: opts.timeoutMs,
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          ...(opts.configPath ? { configPath: opts.configPath } : {}),
        }),
    );
    return { ok: true } as const;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } as const;
  }
}

function formatRuntimeStatus(runtime: DaemonStatus["service"]["runtime"]) {
  if (!runtime) return null;
  const status = runtime.status ?? "unknown";
  const details: string[] = [];
  if (runtime.pid) details.push(`pid ${runtime.pid}`);
  if (runtime.state && runtime.state.toLowerCase() !== status) {
    details.push(`state ${runtime.state}`);
  }
  if (runtime.subState) details.push(`sub ${runtime.subState}`);
  if (runtime.lastExitStatus !== undefined) {
    details.push(`last exit ${runtime.lastExitStatus}`);
  }
  if (runtime.lastExitReason) {
    details.push(`reason ${runtime.lastExitReason}`);
  }
  if (runtime.lastRunResult) {
    details.push(`last run ${runtime.lastRunResult}`);
  }
  if (runtime.lastRunTime) {
    details.push(`last run time ${runtime.lastRunTime}`);
  }
  if (runtime.detail) details.push(runtime.detail);
  return details.length > 0 ? `${status} (${details.join(", ")})` : status;
}

function shouldReportPortUsage(
  status: PortUsageStatus | undefined,
  rpcOk?: boolean,
) {
  if (status !== "busy") return false;
  if (rpcOk === true) return false;
  return true;
}

function renderRuntimeHints(
  runtime: DaemonStatus["service"]["runtime"],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!runtime) return [];
  const hints: string[] = [];
  const fileLog = (() => {
    try {
      return getResolvedLoggerSettings().file;
    } catch {
      return null;
    }
  })();
  if (runtime.missingUnit) {
    hints.push("Service not installed. Run: clawdbot daemon install");
    if (fileLog) hints.push(`File logs: ${fileLog}`);
    return hints;
  }
  if (runtime.status === "stopped") {
    if (fileLog) hints.push(`File logs: ${fileLog}`);
    if (process.platform === "darwin") {
      const logs = resolveGatewayLogPaths(env);
      hints.push(`Launchd stdout (if installed): ${logs.stdoutPath}`);
      hints.push(`Launchd stderr (if installed): ${logs.stderrPath}`);
    } else if (process.platform === "linux") {
      const unit = resolveGatewaySystemdServiceName(env.CLAWDBOT_PROFILE);
      hints.push(
        `Logs: journalctl --user -u ${unit}.service -n 200 --no-pager`,
      );
    } else if (process.platform === "win32") {
      const task = resolveGatewayWindowsTaskName(env.CLAWDBOT_PROFILE);
      hints.push(`Logs: schtasks /Query /TN "${task}" /V /FO LIST`);
    }
  }
  return hints;
}

function renderGatewayServiceStartHints(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const base = ["clawdbot daemon install", "clawdbot gateway"];
  const profile = env.CLAWDBOT_PROFILE;
  switch (process.platform) {
    case "darwin": {
      const label = resolveGatewayLaunchAgentLabel(profile);
      return [
        ...base,
        `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/${label}.plist`,
      ];
    }
    case "linux": {
      const unit = resolveGatewaySystemdServiceName(profile);
      return [...base, `systemctl --user start ${unit}.service`];
    }
    case "win32": {
      const task = resolveGatewayWindowsTaskName(profile);
      return [...base, `schtasks /Run /TN "${task}"`];
    }
    default:
      return base;
  }
}

async function gatherDaemonStatus(opts: {
  rpc: GatewayRpcOpts;
  probe: boolean;
  deep?: boolean;
}): Promise<DaemonStatus> {
  const service = resolveGatewayService();
  const [loaded, command, runtime] = await Promise.all([
    service
      .isLoaded({ profile: process.env.CLAWDBOT_PROFILE })
      .catch(() => false),
    service.readCommand(process.env).catch(() => null),
    service.readRuntime(process.env).catch(() => undefined),
  ]);
  const configAudit = await auditGatewayServiceConfig({
    env: process.env,
    command,
  });

  const serviceEnv = command?.environment ?? undefined;
  const mergedDaemonEnv = {
    ...(process.env as Record<string, string | undefined>),
    ...(serviceEnv ?? undefined),
  } satisfies Record<string, string | undefined>;

  const cliConfigPath = resolveConfigPath(
    process.env,
    resolveStateDir(process.env),
  );
  const daemonConfigPath = resolveConfigPath(
    mergedDaemonEnv as NodeJS.ProcessEnv,
    resolveStateDir(mergedDaemonEnv as NodeJS.ProcessEnv),
  );

  const cliIO = createConfigIO({ env: process.env, configPath: cliConfigPath });
  const daemonIO = createConfigIO({
    env: mergedDaemonEnv,
    configPath: daemonConfigPath,
  });

  const [cliSnapshot, daemonSnapshot] = await Promise.all([
    cliIO.readConfigFileSnapshot().catch(() => null),
    daemonIO.readConfigFileSnapshot().catch(() => null),
  ]);
  const cliCfg = cliIO.loadConfig();
  const daemonCfg = daemonIO.loadConfig();

  const cliConfigSummary: ConfigSummary = {
    path: cliSnapshot?.path ?? cliConfigPath,
    exists: cliSnapshot?.exists ?? false,
    valid: cliSnapshot?.valid ?? true,
    ...(cliSnapshot?.issues?.length ? { issues: cliSnapshot.issues } : {}),
    controlUi: cliCfg.gateway?.controlUi,
  };
  const daemonConfigSummary: ConfigSummary = {
    path: daemonSnapshot?.path ?? daemonConfigPath,
    exists: daemonSnapshot?.exists ?? false,
    valid: daemonSnapshot?.valid ?? true,
    ...(daemonSnapshot?.issues?.length
      ? { issues: daemonSnapshot.issues }
      : {}),
    controlUi: daemonCfg.gateway?.controlUi,
  };
  const configMismatch = cliConfigSummary.path !== daemonConfigSummary.path;

  const portFromArgs = parsePortFromArgs(command?.programArguments);
  const daemonPort =
    portFromArgs ?? resolveGatewayPort(daemonCfg, mergedDaemonEnv);
  const portSource: GatewayStatusSummary["portSource"] = portFromArgs
    ? "service args"
    : "env/config";

  const bindMode = (daemonCfg.gateway?.bind ?? "loopback") as
    | "auto"
    | "lan"
    | "tailnet"
    | "loopback";
  const bindHost = resolveGatewayBindHost(bindMode);
  const tailnetIPv4 = pickPrimaryTailnetIPv4();
  const probeHost = pickProbeHostForBind(bindMode, tailnetIPv4);
  const probeUrlOverride =
    typeof opts.rpc.url === "string" && opts.rpc.url.trim().length > 0
      ? opts.rpc.url.trim()
      : null;
  const probeUrl = probeUrlOverride ?? `ws://${probeHost}:${daemonPort}`;
  const probeNote =
    !probeUrlOverride && bindMode === "lan"
      ? "Local probe uses loopback (127.0.0.1). bind=lan listens on 0.0.0.0 (all interfaces); use a LAN IP for remote clients."
      : !probeUrlOverride && bindMode === "loopback"
        ? "Loopback-only gateway; only local clients can connect."
        : undefined;

  const cliPort = resolveGatewayPort(cliCfg, process.env);
  const [portDiagnostics, portCliDiagnostics] = await Promise.all([
    inspectPortUsage(daemonPort).catch(() => null),
    cliPort !== daemonPort ? inspectPortUsage(cliPort).catch(() => null) : null,
  ]);
  const portStatus: DaemonStatus["port"] | undefined = portDiagnostics
    ? {
        port: portDiagnostics.port,
        status: portDiagnostics.status,
        listeners: portDiagnostics.listeners,
        hints: portDiagnostics.hints,
      }
    : undefined;
  const portCliStatus: DaemonStatus["portCli"] | undefined = portCliDiagnostics
    ? {
        port: portCliDiagnostics.port,
        status: portCliDiagnostics.status,
        listeners: portCliDiagnostics.listeners,
        hints: portCliDiagnostics.hints,
      }
    : undefined;

  const legacyServices = await findLegacyGatewayServices(process.env);
  const extraServices = await findExtraGatewayServices(process.env, {
    deep: opts.deep,
  });

  const timeoutMsRaw = Number.parseInt(String(opts.rpc.timeout ?? "10000"), 10);
  const timeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 10_000;

  const rpc = opts.probe
    ? await probeGatewayStatus({
        url: probeUrl,
        token:
          opts.rpc.token ||
          mergedDaemonEnv.CLAWDBOT_GATEWAY_TOKEN ||
          daemonCfg.gateway?.auth?.token,
        password:
          opts.rpc.password ||
          mergedDaemonEnv.CLAWDBOT_GATEWAY_PASSWORD ||
          daemonCfg.gateway?.auth?.password,
        timeoutMs,
        json: opts.rpc.json,
        configPath: daemonConfigSummary.path,
      })
    : undefined;
  let lastError: string | undefined;
  if (
    loaded &&
    runtime?.status === "running" &&
    portStatus &&
    portStatus.status !== "busy"
  ) {
    lastError =
      (await readLastGatewayErrorLine(mergedDaemonEnv as NodeJS.ProcessEnv)) ??
      undefined;
  }

  return {
    service: {
      label: service.label,
      loaded,
      loadedText: service.loadedText,
      notLoadedText: service.notLoadedText,
      command,
      runtime,
      configAudit,
    },
    config: {
      cli: cliConfigSummary,
      daemon: daemonConfigSummary,
      ...(configMismatch ? { mismatch: true } : {}),
    },
    gateway: {
      bindMode,
      bindHost,
      port: daemonPort,
      portSource,
      probeUrl,
      ...(probeNote ? { probeNote } : {}),
    },
    port: portStatus,
    ...(portCliStatus ? { portCli: portCliStatus } : {}),
    lastError,
    ...(rpc ? { rpc: { ...rpc, url: probeUrl } } : {}),
    legacyServices,
    extraServices,
  };
}

function printDaemonStatus(status: DaemonStatus, opts: { json: boolean }) {
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(status, null, 2));
    return;
  }

  const rich = isRich();
  const label = (value: string) => colorize(rich, theme.muted, value);
  const accent = (value: string) => colorize(rich, theme.accent, value);
  const infoText = (value: string) => colorize(rich, theme.info, value);
  const okText = (value: string) => colorize(rich, theme.success, value);
  const warnText = (value: string) => colorize(rich, theme.warn, value);
  const errorText = (value: string) => colorize(rich, theme.error, value);
  const spacer = () => defaultRuntime.log("");

  const { service, rpc, legacyServices, extraServices } = status;
  const serviceStatus = service.loaded
    ? okText(service.loadedText)
    : warnText(service.notLoadedText);
  defaultRuntime.log(
    `${label("Service:")} ${accent(service.label)} (${serviceStatus})`,
  );
  try {
    const logFile = getResolvedLoggerSettings().file;
    defaultRuntime.log(`${label("File logs:")} ${infoText(logFile)}`);
  } catch {
    // ignore missing config/log resolution
  }
  if (service.command?.programArguments?.length) {
    defaultRuntime.log(
      `${label("Command:")} ${infoText(service.command.programArguments.join(" "))}`,
    );
  }
  if (service.command?.sourcePath) {
    defaultRuntime.log(
      `${label("Service file:")} ${infoText(service.command.sourcePath)}`,
    );
  }
  if (service.command?.workingDirectory) {
    defaultRuntime.log(
      `${label("Working dir:")} ${infoText(service.command.workingDirectory)}`,
    );
  }
  const daemonEnvLines = safeDaemonEnv(service.command?.environment);
  if (daemonEnvLines.length > 0) {
    defaultRuntime.log(`${label("Daemon env:")} ${daemonEnvLines.join(" ")}`);
  }
  spacer();
  if (service.configAudit?.issues.length) {
    defaultRuntime.error(
      warnText("Service config looks out of date or non-standard."),
    );
    for (const issue of service.configAudit.issues) {
      const detail = issue.detail ? ` (${issue.detail})` : "";
      defaultRuntime.error(
        `${warnText("Service config issue:")} ${issue.message}${detail}`,
      );
    }
    defaultRuntime.error(
      warnText(
        'Recommendation: run "clawdbot doctor" (or "clawdbot doctor --repair").',
      ),
    );
  }
  if (status.config) {
    const cliCfg = `${status.config.cli.path}${status.config.cli.exists ? "" : " (missing)"}${status.config.cli.valid ? "" : " (invalid)"}`;
    defaultRuntime.log(`${label("Config (cli):")} ${infoText(cliCfg)}`);
    if (!status.config.cli.valid && status.config.cli.issues?.length) {
      for (const issue of status.config.cli.issues.slice(0, 5)) {
        defaultRuntime.error(
          `${errorText("Config issue:")} ${issue.path || "<root>"}: ${issue.message}`,
        );
      }
    }
    if (status.config.daemon) {
      const daemonCfg = `${status.config.daemon.path}${status.config.daemon.exists ? "" : " (missing)"}${status.config.daemon.valid ? "" : " (invalid)"}`;
      defaultRuntime.log(`${label("Config (daemon):")} ${infoText(daemonCfg)}`);
      if (!status.config.daemon.valid && status.config.daemon.issues?.length) {
        for (const issue of status.config.daemon.issues.slice(0, 5)) {
          defaultRuntime.error(
            `${errorText("Daemon config issue:")} ${issue.path || "<root>"}: ${issue.message}`,
          );
        }
      }
    }
    if (status.config.mismatch) {
      defaultRuntime.error(
        errorText(
          "Root cause: CLI and daemon are using different config paths (likely a profile/state-dir mismatch).",
        ),
      );
      defaultRuntime.error(
        errorText(
          "Fix: rerun `clawdbot daemon install --force` from the same --profile / CLAWDBOT_STATE_DIR you expect.",
        ),
      );
    }
    spacer();
  }
  if (status.gateway) {
    const bindHost = status.gateway.bindHost ?? "n/a";
    defaultRuntime.log(
      `${label("Gateway:")} bind=${infoText(status.gateway.bindMode)} (${infoText(bindHost)}), port=${infoText(String(status.gateway.port))} (${infoText(status.gateway.portSource)})`,
    );
    defaultRuntime.log(
      `${label("Probe target:")} ${infoText(status.gateway.probeUrl)}`,
    );
    const controlUiEnabled = status.config?.daemon?.controlUi?.enabled ?? true;
    if (!controlUiEnabled) {
      defaultRuntime.log(`${label("Dashboard:")} ${warnText("disabled")}`);
    } else {
      const links = resolveControlUiLinks({
        port: status.gateway.port,
        bind: status.gateway.bindMode,
        basePath: status.config?.daemon?.controlUi?.basePath,
      });
      defaultRuntime.log(`${label("Dashboard:")} ${infoText(links.httpUrl)}`);
    }
    if (status.gateway.probeNote) {
      defaultRuntime.log(
        `${label("Probe note:")} ${infoText(status.gateway.probeNote)}`,
      );
    }
    if (status.gateway.bindMode === "tailnet" && !status.gateway.bindHost) {
      defaultRuntime.error(
        errorText(
          "Root cause: gateway bind=tailnet but no tailnet interface was found.",
        ),
      );
    }
    spacer();
  }
  const runtimeLine = formatRuntimeStatus(service.runtime);
  if (runtimeLine) {
    const runtimeStatus = service.runtime?.status ?? "unknown";
    const runtimeColor =
      runtimeStatus === "running"
        ? theme.success
        : runtimeStatus === "stopped"
          ? theme.error
          : runtimeStatus === "unknown"
            ? theme.muted
            : theme.warn;
    defaultRuntime.log(
      `${label("Runtime:")} ${colorize(rich, runtimeColor, runtimeLine)}`,
    );
  }
  if (
    rpc &&
    !rpc.ok &&
    service.loaded &&
    service.runtime?.status === "running"
  ) {
    defaultRuntime.log(
      warnText(
        "Warm-up: launch agents can take a few seconds. Try again shortly.",
      ),
    );
  }
  if (rpc) {
    if (rpc.ok) {
      defaultRuntime.log(`${label("RPC probe:")} ${okText("ok")}`);
    } else {
      defaultRuntime.error(`${label("RPC probe:")} ${errorText("failed")}`);
      if (rpc.url) defaultRuntime.error(`${label("RPC target:")} ${rpc.url}`);
      const lines = String(rpc.error ?? "unknown")
        .split(/\r?\n/)
        .filter(Boolean);
      for (const line of lines.slice(0, 12)) {
        defaultRuntime.error(`  ${errorText(line)}`);
      }
    }
    spacer();
  }
  if (service.runtime?.missingUnit) {
    defaultRuntime.error(errorText("Service unit not found."));
    for (const hint of renderRuntimeHints(service.runtime)) {
      defaultRuntime.error(errorText(hint));
    }
  } else if (service.loaded && service.runtime?.status === "stopped") {
    defaultRuntime.error(
      errorText(
        "Service is loaded but not running (likely exited immediately).",
      ),
    );
    for (const hint of renderRuntimeHints(
      service.runtime,
      (service.command?.environment ?? process.env) as NodeJS.ProcessEnv,
    )) {
      defaultRuntime.error(errorText(hint));
    }
    spacer();
  }
  if (service.runtime?.cachedLabel) {
    const env = (service.command?.environment ??
      process.env) as NodeJS.ProcessEnv;
    const label = resolveGatewayLaunchAgentLabel(env.CLAWDBOT_PROFILE);
    defaultRuntime.error(
      errorText(
        `LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${label}`,
      ),
    );
    defaultRuntime.error(errorText("Then reinstall: clawdbot daemon install"));
    spacer();
  }
  if (status.port && shouldReportPortUsage(status.port.status, rpc?.ok)) {
    for (const line of formatPortDiagnostics({
      port: status.port.port,
      status: status.port.status,
      listeners: status.port.listeners,
      hints: status.port.hints,
    })) {
      defaultRuntime.error(errorText(line));
    }
  }
  if (status.port) {
    const addrs = Array.from(
      new Set(
        status.port.listeners
          .map((l) => (l.address ? normalizeListenerAddress(l.address) : ""))
          .filter((v): v is string => Boolean(v)),
      ),
    );
    if (addrs.length > 0) {
      defaultRuntime.log(
        `${label("Listening:")} ${infoText(addrs.join(", "))}`,
      );
    }
  }
  if (status.portCli && status.portCli.port !== status.port?.port) {
    defaultRuntime.log(
      `${label("Note:")} CLI config resolves gateway port=${status.portCli.port} (${status.portCli.status}).`,
    );
  }
  if (
    service.loaded &&
    service.runtime?.status === "running" &&
    status.port &&
    status.port.status !== "busy"
  ) {
    defaultRuntime.error(
      errorText(
        `Gateway port ${status.port.port} is not listening (service appears running).`,
      ),
    );
    if (status.lastError) {
      defaultRuntime.error(
        `${errorText("Last gateway error:")} ${status.lastError}`,
      );
    }
    if (process.platform === "linux") {
      const env = (service.command?.environment ??
        process.env) as NodeJS.ProcessEnv;
      const unit = resolveGatewaySystemdServiceName(env.CLAWDBOT_PROFILE);
      defaultRuntime.error(
        errorText(
          `Logs: journalctl --user -u ${unit}.service -n 200 --no-pager`,
        ),
      );
    } else if (process.platform === "darwin") {
      const logs = resolveGatewayLogPaths(
        (service.command?.environment ?? process.env) as NodeJS.ProcessEnv,
      );
      defaultRuntime.error(`${errorText("Logs:")} ${logs.stdoutPath}`);
      defaultRuntime.error(`${errorText("Errors:")} ${logs.stderrPath}`);
    }
    spacer();
  }

  if (legacyServices.length > 0) {
    defaultRuntime.error(errorText("Legacy Clawdis services detected:"));
    for (const svc of legacyServices) {
      defaultRuntime.error(`- ${errorText(svc.label)} (${svc.detail})`);
    }
    defaultRuntime.error(errorText("Cleanup: clawdbot doctor"));
    spacer();
  }

  if (extraServices.length > 0) {
    defaultRuntime.error(
      errorText("Other gateway-like services detected (best effort):"),
    );
    for (const svc of extraServices) {
      defaultRuntime.error(
        `- ${errorText(svc.label)} (${svc.scope}, ${svc.detail})`,
      );
    }
    for (const hint of renderGatewayServiceCleanupHints()) {
      defaultRuntime.error(`${errorText("Cleanup hint:")} ${hint}`);
    }
    spacer();
  }

  if (legacyServices.length > 0 || extraServices.length > 0) {
    defaultRuntime.error(
      errorText(
        "Recommendation: run a single gateway per machine. One gateway supports multiple agents.",
      ),
    );
    defaultRuntime.error(
      errorText(
        "If you need multiple gateways, isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host).",
      ),
    );
    spacer();
  }
  defaultRuntime.log(`${label("Troubles:")} run clawdbot status`);
  defaultRuntime.log(
    `${label("Troubleshooting:")} https://docs.clawd.bot/troubleshooting`,
  );
}

export async function runDaemonStatus(opts: DaemonStatusOptions) {
  try {
    const status = await gatherDaemonStatus({
      rpc: opts.rpc,
      probe: Boolean(opts.probe),
      deep: Boolean(opts.deep),
    });
    printDaemonStatus(status, { json: Boolean(opts.json) });
  } catch (err) {
    const rich = isRich();
    defaultRuntime.error(
      colorize(rich, theme.error, `Daemon status failed: ${String(err)}`),
    );
    defaultRuntime.exit(1);
  }
}

export async function runDaemonInstall(opts: DaemonInstallOptions) {
  if (resolveIsNixMode(process.env)) {
    defaultRuntime.error("Nix mode detected; daemon install is disabled.");
    defaultRuntime.exit(1);
    return;
  }

  const cfg = loadConfig();
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
    return;
  }
  const port = portOverride ?? resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
    return;
  }
  const runtimeRaw = opts.runtime
    ? String(opts.runtime)
    : DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!isGatewayDaemonRuntime(runtimeRaw)) {
    defaultRuntime.error('Invalid --runtime (use "node" or "bun")');
    defaultRuntime.exit(1);
    return;
  }

  const service = resolveGatewayService();
  const profile = process.env.CLAWDBOT_PROFILE;
  let loaded = false;
  try {
    loaded = await service.isLoaded({ profile });
  } catch (err) {
    defaultRuntime.error(`Gateway service check failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return;
  }
  if (loaded) {
    if (!opts.force) {
      defaultRuntime.log(`Gateway service already ${service.loadedText}.`);
      defaultRuntime.log("Reinstall with: clawdbot daemon install --force");
      return;
    }
  }

  const devMode =
    process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
    process.argv[1]?.endsWith(".ts");
  const nodePath = await resolvePreferredNodePath({
    env: process.env,
    runtime: runtimeRaw,
  });
  const { programArguments, workingDirectory } =
    await resolveGatewayProgramArguments({
      port,
      dev: devMode,
      runtime: runtimeRaw,
      nodePath,
    });
  const environment = buildServiceEnvironment({
    env: process.env,
    port,
    token:
      opts.token ||
      cfg.gateway?.auth?.token ||
      process.env.CLAWDBOT_GATEWAY_TOKEN,
    launchdLabel:
      process.platform === "darwin"
        ? resolveGatewayLaunchAgentLabel(profile)
        : undefined,
  });

  try {
    await service.install({
      env: process.env,
      stdout: process.stdout,
      programArguments,
      workingDirectory,
      environment,
    });
  } catch (err) {
    defaultRuntime.error(`Gateway install failed: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

export async function runDaemonUninstall() {
  if (resolveIsNixMode(process.env)) {
    defaultRuntime.error("Nix mode detected; daemon uninstall is disabled.");
    defaultRuntime.exit(1);
    return;
  }

  const service = resolveGatewayService();
  try {
    await service.uninstall({ env: process.env, stdout: process.stdout });
  } catch (err) {
    defaultRuntime.error(`Gateway uninstall failed: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

export async function runDaemonStart() {
  const service = resolveGatewayService();
  const profile = process.env.CLAWDBOT_PROFILE;
  let loaded = false;
  try {
    loaded = await service.isLoaded({ profile });
  } catch (err) {
    defaultRuntime.error(`Gateway service check failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return;
  }
  if (!loaded) {
    defaultRuntime.log(`Gateway service ${service.notLoadedText}.`);
    for (const hint of renderGatewayServiceStartHints()) {
      defaultRuntime.log(`Start with: ${hint}`);
    }
    return;
  }
  try {
    await service.restart({ profile, stdout: process.stdout });
  } catch (err) {
    defaultRuntime.error(`Gateway start failed: ${String(err)}`);
    for (const hint of renderGatewayServiceStartHints()) {
      defaultRuntime.error(`Start with: ${hint}`);
    }
    defaultRuntime.exit(1);
  }
}

export async function runDaemonStop() {
  const service = resolveGatewayService();
  const profile = process.env.CLAWDBOT_PROFILE;
  let loaded = false;
  try {
    loaded = await service.isLoaded({ profile });
  } catch (err) {
    defaultRuntime.error(`Gateway service check failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return;
  }
  if (!loaded) {
    defaultRuntime.log(`Gateway service ${service.notLoadedText}.`);
    return;
  }
  try {
    await service.stop({ profile, stdout: process.stdout });
  } catch (err) {
    defaultRuntime.error(`Gateway stop failed: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

/**
 * Restart the gateway daemon service.
 * @returns `true` if restart succeeded, `false` if the service was not loaded.
 * Throws/exits on check or restart failures.
 */
export async function runDaemonRestart(): Promise<boolean> {
  const service = resolveGatewayService();
  const profile = process.env.CLAWDBOT_PROFILE;
  let loaded = false;
  try {
    loaded = await service.isLoaded({ profile });
  } catch (err) {
    defaultRuntime.error(`Gateway service check failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return false;
  }
  if (!loaded) {
    defaultRuntime.log(`Gateway service ${service.notLoadedText}.`);
    for (const hint of renderGatewayServiceStartHints()) {
      defaultRuntime.log(`Start with: ${hint}`);
    }
    return false;
  }
  try {
    await service.restart({ profile, stdout: process.stdout });
    return true;
  } catch (err) {
    defaultRuntime.error(`Gateway restart failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return false;
  }
}

export function registerDaemonCli(program: Command) {
  const daemon = program
    .command("daemon")
    .description("Manage the Gateway daemon service (launchd/systemd/schtasks)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/gateway",
          "docs.clawd.bot/gateway",
        )}\n`,
    );

  daemon
    .command("status")
    .description("Show daemon install status + probe the Gateway")
    .option(
      "--url <url>",
      "Gateway WebSocket URL (defaults to config/remote/local)",
    )
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--no-probe", "Skip RPC probe")
    .option("--deep", "Scan system-level services", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runDaemonStatus({
        rpc: opts,
        probe: Boolean(opts.probe),
        deep: Boolean(opts.deep),
        json: Boolean(opts.json),
      });
    });

  daemon
    .command("install")
    .description("Install the Gateway service (launchd/systemd/schtasks)")
    .option("--port <port>", "Gateway port")
    .option("--runtime <runtime>", "Daemon runtime (node|bun). Default: node")
    .option("--token <token>", "Gateway token (token auth)")
    .option("--force", "Reinstall/overwrite if already installed", false)
    .action(async (opts) => {
      await runDaemonInstall(opts);
    });

  daemon
    .command("uninstall")
    .description("Uninstall the Gateway service (launchd/systemd/schtasks)")
    .action(async () => {
      await runDaemonUninstall();
    });

  daemon
    .command("start")
    .description("Start the Gateway service (launchd/systemd/schtasks)")
    .action(async () => {
      await runDaemonStart();
    });

  daemon
    .command("stop")
    .description("Stop the Gateway service (launchd/systemd/schtasks)")
    .action(async () => {
      await runDaemonStop();
    });

  daemon
    .command("restart")
    .description("Restart the Gateway service (launchd/systemd/schtasks)")
    .action(async () => {
      await runDaemonRestart();
    });

  // Build default deps (parity with other commands).
  void createDefaultDeps();
}
