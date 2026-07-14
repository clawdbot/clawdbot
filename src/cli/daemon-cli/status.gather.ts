// Collects daemon status from service files, config snapshots, ports, probes, and plugin drift.
import fs from "node:fs/promises";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import JSON5 from "json5";
import {
  createConfigIO,
  resolveConfigPath,
  resolveGatewayPort,
  resolveStateDir,
} from "../../config/config.js";
import type {
  OpenClawConfig,
  ConfigFileSnapshot,
  GatewayBindMode,
  GatewayControlUiConfig,
} from "../../config/types.js";
import { resolveSecretInputRef } from "../../config/types.secrets.js";
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";
import type { StaleOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import type { ServiceConfigAudit } from "../../daemon/service-audit.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { resolveAdvertisedControlUiLinks } from "../../gateway/control-ui-links.js";
import { gatewaySecretInputPathCanWin } from "../../gateway/credentials-secret-inputs.js";
import { trimToUndefined } from "../../gateway/credentials.js";
import { resolveGatewayProbeCredentialConfig } from "../../gateway/probe-auth.js";
import {
  ALL_GATEWAY_SECRET_INPUT_PATHS,
  readGatewaySecretInputValue,
} from "../../gateway/secret-input-paths.js";
import {
  inspectBestEffortPrimaryTailnetIPv4,
  resolveBestEffortGatewayBindHostForDisplay,
} from "../../infra/network-discovery-display.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import {
  formatPortDiagnostics,
  inspectPortConnections,
  inspectPortUsage,
  type PortConnection,
  type PortListener,
  type PortUsageStatus,
} from "../../infra/ports.js";
import {
  readGatewayRestartHandoffSync,
  type GatewayRestartHandoff,
} from "../../infra/restart-handoff.js";
import {
  inspectWindowsGatewayFirewall,
  type WindowsGatewayFirewallDiagnostic,
} from "../../infra/windows-gateway-firewall-diagnostics.js";
import { resolveConfiguredLogFilePath } from "../../logging/log-file-path.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-record-reader.js";
import {
  detectPluginVersionDrift,
  type PluginVersionDriftReport,
} from "../../plugins/plugin-version-drift.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { VERSION } from "../../version.js";
import { normalizeListenerAddress, parsePortFromArgs, pickProbeHostForBind } from "./shared.js";
import type { GatewayRpcOpts } from "./types.js";

type ConfigSummary = {
  path: string;
  exists: boolean;
  valid: boolean;
  issues?: Array<{ path: string; message: string }>;
  warnings?: ConfigFileSnapshot["warnings"];
  controlUi?: GatewayControlUiConfig;
};

type GatewayStatusSummary = {
  bindMode: GatewayBindMode;
  bindHost: string;
  customBindHost?: string;
  tlsEnabled?: boolean;
  port: number;
  portSource: "service args" | "env/config";
  probeUrl: string;
  controlUiLinks?: { httpUrl: string; wsUrl: string };
  probeNote?: string;
  version?: string | null;
  windowsFirewall?: WindowsGatewayFirewallDiagnostic;
};

type PortStatusSummary = {
  port: number;
  status: PortUsageStatus;
  listeners: PortListener[];
  hints: string[];
};

type DaemonConfigContext = {
  mergedDaemonEnv: Record<string, string | undefined>;
  cliCfg: OpenClawConfig;
  daemonCfg: OpenClawConfig;
  cliConfigSummary: ConfigSummary;
  daemonConfigSummary: ConfigSummary;
  configMismatch: boolean;
};

type StatusConfigRead = {
  summary: ConfigSummary;
  cfg: OpenClawConfig;
  mode: "fast" | "full";
};

type ResolvedGatewayStatus = {
  gateway: GatewayStatusSummary;
  daemonPort: number;
  cliPort: number;
  probeUrlOverride: string | null;
};

type CliStatusSummary = {
  version: string;
  entrypoint?: string;
};

const gatewayProbeAuthModuleLoader = createLazyImportLoader(
  () => import("../../gateway/probe-auth.js"),
);
const daemonInspectModuleLoader = createLazyImportLoader(() => import("../../daemon/inspect.js"));
const launchdModuleLoader = createLazyImportLoader(() => import("../../daemon/launchd.js"));
const serviceAuditModuleLoader = createLazyImportLoader(
  () => import("../../daemon/service-audit.js"),
);
const gatewayTlsModuleLoader = createLazyImportLoader(() => import("../../infra/tls/gateway.js"));
const daemonProbeModuleLoader = createLazyImportLoader(() => import("./probe.js"));
const restartHealthModuleLoader = createLazyImportLoader(() => import("./restart-health.js"));

function loadGatewayProbeAuthModule() {
  return gatewayProbeAuthModuleLoader.load();
}

function loadDaemonInspectModule() {
  return daemonInspectModuleLoader.load();
}

function loadLaunchdModule() {
  return launchdModuleLoader.load();
}

function loadServiceAuditModule() {
  return serviceAuditModuleLoader.load();
}

function loadGatewayTlsModule() {
  return gatewayTlsModuleLoader.load();
}

function loadDaemonProbeModule() {
  return daemonProbeModuleLoader.load();
}

function loadRestartHealthModule() {
  return restartHealthModuleLoader.load();
}

function resolveSnapshotRuntimeConfig(snapshot: ConfigFileSnapshot | null): OpenClawConfig | null {
  if (!snapshot?.valid || !snapshot.runtimeConfig) {
    return null;
  }
  return snapshot.runtimeConfig;
}

function coerceStatusConfig(value: unknown): OpenClawConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as OpenClawConfig;
}

function hasOwnKey(value: unknown, key: string): boolean {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key),
  );
}

function needsFullStatusConfigRead(raw: string, parsed: unknown): boolean {
  // Fast reads skip config expansion; includes/env placeholders require full config IO.
  return raw.includes("$include") || raw.includes("${") || hasOwnKey(parsed, "env");
}

async function readFastStatusConfig(configPath: string): Promise<StatusConfigRead | null> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw);
  } catch (err) {
    return {
      summary: {
        path: configPath,
        exists: true,
        valid: false,
        issues: [{ path: "", message: `JSON5 parse failed: ${String(err)}` }],
      },
      cfg: {},
      mode: "fast",
    };
  }

  if (needsFullStatusConfigRead(raw, parsed)) {
    return null;
  }

  const cfg = coerceStatusConfig(parsed);
  return {
    summary: {
      path: configPath,
      exists: true,
      valid: true,
      controlUi: cfg.gateway?.controlUi,
    },
    cfg,
    mode: "fast",
  };
}

async function readFullStatusConfig(params: {
  env: NodeJS.ProcessEnv;
  configPath: string;
  pluginValidation?: "full" | "skip";
}): Promise<StatusConfigRead> {
  const io = createConfigIO({
    env: params.env,
    configPath: params.configPath,
    pluginValidation: params.pluginValidation ?? "skip",
    logger: {
      error: () => {},
      warn: () => {},
    },
  });
  const snapshot = await io.readConfigFileSnapshot().catch(() => null);
  const cfg = resolveSnapshotRuntimeConfig(snapshot) ?? io.loadConfig();
  return {
    summary: {
      path: snapshot?.path ?? params.configPath,
      exists: snapshot?.exists ?? false,
      valid: snapshot?.valid ?? true,
      ...(snapshot?.issues?.length ? { issues: snapshot.issues } : {}),
      ...(snapshot?.warnings?.length ? { warnings: snapshot.warnings } : {}),
      controlUi: cfg.gateway?.controlUi,
    },
    cfg,
    mode: "full",
  };
}

async function readStatusConfig(params: {
  env: NodeJS.ProcessEnv;
  configPath: string;
  deep?: boolean;
}): Promise<StatusConfigRead> {
  return (
    (params.deep ? null : await readFastStatusConfig(params.configPath)) ??
    (await readFullStatusConfig({
      env: params.env,
      configPath: params.configPath,
      pluginValidation: params.deep ? "full" : "skip",
    }))
  );
}

function appendProbeNote(
  existing: string | undefined,
  extra: string | undefined,
): string | undefined {
  const values = [existing, extra].filter((value): value is string => Boolean(value?.trim()));
  if (values.length === 0) {
    return undefined;
  }
  return uniqueStrings(values).join(" ");
}
export type DaemonStatus = {
  cli?: CliStatusSummary;
  logFile?: string;
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
    runtime?: GatewayServiceRuntime;
    configAudit?: ServiceConfigAudit;
    restartHandoff?: GatewayRestartHandoff;
    staleUpdateLaunchdJobs?: StaleOpenClawUpdateLaunchdJob[];
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
  connections?: {
    port: number;
    established: PortConnection[];
  };
  lastError?: string;
  rpc?: {
    ok: boolean;
    kind?: "connect" | "read";
    capability?: string;
    auth?: {
      role?: string | null;
      scopes?: string[];
      capability?: string;
    };
    server?: {
      version?: string | null;
      connId?: string | null;
    };
    version?: string | null;
    error?: string;
    url?: string;
    authWarning?: string;
  };
  health?: {
    healthy: boolean;
    staleGatewayPids: number[];
  };
  extraServices: Array<{ label: string; detail: string; scope: string }>;
  /**
   * Plugin version drift report. Surfaces active official external plugins
   * whose installed version does not match the running gateway version, which
   * can happen after `npm install -g openclaw@<v>` updates the gateway binary
   * without a corresponding `openclaw plugins update`.
   */
  pluginVersionDrift?: PluginVersionDriftReport;
};

function shouldReportPortUsage(status: PortUsageStatus | undefined, rpcOk?: boolean) {
  if (status !== "busy") {
    return false;
  }
  if (rpcOk === true) {
    return false;
  }
  return true;
}

function resolveCliStatusSummary(argv: string[] = process.argv): CliStatusSummary {
  const entrypoint = argv[1]?.trim();
  return {
    version: VERSION,
    ...(entrypoint ? { entrypoint } : {}),
  };
}

async function loadDaemonConfigContext(
  serviceEnv?: Record<string, string>,
  opts: { deep?: boolean } = {},
): Promise<DaemonConfigContext> {
  const mergedDaemonEnv = {
    ...(process.env as Record<string, string | undefined>),
    ...(serviceEnv ?? undefined),
  } satisfies Record<string, string | undefined>;

  const cliConfigPath = resolveConfigPath(process.env, resolveStateDir(process.env));
  const daemonConfigPath = resolveConfigPath(
    mergedDaemonEnv as NodeJS.ProcessEnv,
    resolveStateDir(mergedDaemonEnv as NodeJS.ProcessEnv),
  );
  const sameConfigPath = cliConfigPath === daemonConfigPath;
  const cliConfigRead = await readStatusConfig({
    env: process.env,
    configPath: cliConfigPath,
    deep: opts.deep,
  });
  const sharesDaemonConfigContext =
    sameConfigPath && (cliConfigRead.mode === "fast" || !serviceEnv);
  const daemonConfigRead = sharesDaemonConfigContext
    ? cliConfigRead
    : await readStatusConfig({
        env: mergedDaemonEnv as NodeJS.ProcessEnv,
        configPath: daemonConfigPath,
        deep: opts.deep,
      });

  return {
    mergedDaemonEnv,
    cliCfg: cliConfigRead.cfg,
    daemonCfg: daemonConfigRead.cfg,
    cliConfigSummary: cliConfigRead.summary,
    daemonConfigSummary: daemonConfigRead.summary,
    configMismatch: cliConfigRead.summary.path !== daemonConfigRead.summary.path,
  };
}

async function resolveGatewayStatusSummary(params: {
  daemonCfg: OpenClawConfig;
  cliCfg: OpenClawConfig;
  mergedDaemonEnv: Record<string, string | undefined>;
  commandProgramArguments?: string[];
  rpcUrlOverride?: string;
}): Promise<ResolvedGatewayStatus> {
  const portFromArgs = parsePortFromArgs(params.commandProgramArguments);
  const daemonPort = portFromArgs ?? resolveGatewayPort(params.daemonCfg, params.mergedDaemonEnv);
  const portSource: GatewayStatusSummary["portSource"] = portFromArgs
    ? "service args"
    : "env/config";
  const bindMode: GatewayBindMode = params.daemonCfg.gateway?.bind ?? "loopback";
  const customBindHost = params.daemonCfg.gateway?.customBindHost;
  const { bindHost, warning: bindHostWarning } = await resolveBestEffortGatewayBindHostForDisplay({
    bindMode,
    customBindHost,
    warningPrefix: "Status is using fallback network details because interface discovery failed",
  });
  const { tailnetIPv4, warning: tailnetWarning } = inspectBestEffortPrimaryTailnetIPv4({
    warningPrefix: "Status could not inspect tailnet addresses",
  });
  const probeHost = pickProbeHostForBind(bindMode, tailnetIPv4, customBindHost);
  const probeUrlOverride = trimToUndefined(params.rpcUrlOverride) ?? null;
  const tlsEnabled = params.daemonCfg.gateway?.tls?.enabled === true;
  const scheme = tlsEnabled ? "wss" : "ws";
  const probeUrl = probeUrlOverride ?? `${scheme}://${probeHost}:${daemonPort}`;
  const controlUiLinks =
    params.daemonCfg.gateway?.controlUi?.enabled === false
      ? undefined
      : await resolveAdvertisedControlUiLinks({
          port: daemonPort,
          bind: bindMode,
          customBindHost,
          basePath: params.daemonCfg.gateway?.controlUi?.basePath,
          tlsEnabled,
        });
  let probeNote =
    !probeUrlOverride && bindMode === "lan"
      ? `bind=lan listens on 0.0.0.0 (all interfaces); probing via ${probeHost}.`
      : !probeUrlOverride && bindMode === "loopback"
        ? "Loopback-only gateway; only local clients can connect."
        : undefined;
  probeNote = appendProbeNote(probeNote, bindHostWarning);
  probeNote = appendProbeNote(probeNote, tailnetWarning);

  return {
    gateway: {
      bindMode,
      bindHost,
      customBindHost,
      ...(tlsEnabled ? { tlsEnabled } : {}),
      port: daemonPort,
      portSource,
      probeUrl,
      ...(controlUiLinks ? { controlUiLinks } : {}),
      ...(probeNote ? { probeNote } : {}),
    },
    daemonPort,
    cliPort: resolveGatewayPort(params.cliCfg, process.env),
    probeUrlOverride,
  };
}

function toPortStatusSummary(
  diagnostics: Awaited<ReturnType<typeof inspectPortUsage>> | null,
): PortStatusSummary | undefined {
  if (!diagnostics) {
    return undefined;
  }
  return {
    port: diagnostics.port,
    status: diagnostics.status,
    listeners: diagnostics.listeners,
    hints: diagnostics.hints,
  };
}

async function inspectDaemonPortStatuses(params: {
  daemonPort: number;
  cliPort: number;
}): Promise<{ portStatus?: PortStatusSummary; portCliStatus?: PortStatusSummary }> {
  const [portDiagnostics, portCliDiagnostics] = await Promise.all([
    inspectPortUsage(params.daemonPort).catch(() => null),
    params.cliPort !== params.daemonPort
      ? inspectPortUsage(params.cliPort).catch(() => null)
      : null,
  ]);
  return {
    portStatus: toPortStatusSummary(portDiagnostics),
    portCliStatus: toPortStatusSummary(portCliDiagnostics),
  };
}

async function inspectEstablishedGatewayClients(params: {
  daemonPort: number;
  deep?: boolean;
  gatewayMode?: string;
}): Promise<DaemonStatus["connections"] | undefined> {
  if (params.deep !== true || params.gatewayMode === "remote") {
    return undefined;
  }
  const result = await inspectPortConnections(params.daemonPort).catch(() => null);
  const establishedClients = result?.connections.filter(
    (connection) => connection.direction !== "server",
  );
  if (!result || !establishedClients || establishedClients.length === 0) {
    return undefined;
  }
  return {
    port: result.port,
    established: establishedClients,
  };
}

function hasActiveGatewayExecProbeCredential(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  explicitAuth: { token?: string; password?: string };
  mode: "local" | "remote";
}): boolean {
  const cfg = resolveGatewayProbeCredentialConfig({
    cfg: params.cfg,
    mode: params.mode,
  });
  return ALL_GATEWAY_SECRET_INPUT_PATHS.some((path) => {
    if (
      !gatewaySecretInputPathCanWin({
        config: cfg,
        env: params.env,
        explicitAuth: params.explicitAuth,
        modeOverride: params.mode,
        path,
        remoteTokenFallback: "remote-only",
      })
    ) {
      return false;
    }
    const ref = resolveSecretInputRef({
      value: readGatewaySecretInputValue(cfg, path),
      defaults: cfg.secrets?.defaults,
    }).ref;
    return ref?.source === "exec";
  });
}

export async function gatherDaemonStatus(
  opts: {
    rpc: GatewayRpcOpts;
    probe: boolean;
    requireRpc?: boolean;
    deep?: boolean;
    allowExecSecretRefs?: boolean;
  } & FindExtraGatewayServicesOptions,
): Promise<DaemonStatus> {
  const service = resolveGatewayService();
  const command = await service.readCommand(process.env).catch(() => null);
  const serviceEnv = command?.environment
    ? ({
        ...process.env,
        ...command.environment,
      } satisfies NodeJS.ProcessEnv)
    : process.env;
  const [loaded, runtime] = await Promise.all([
    service.isLoaded({ env: serviceEnv }).catch(() => false),
    service
      .readRuntime(serviceEnv)
      .catch((err: unknown) => ({ status: "unknown", detail: String(err) })),
  ]);
  const restartHandoff = opts.deep ? readGatewayRestartHandoffSync(serviceEnv) : null;
  const configAudit: ServiceConfigAudit = command
    ? await loadServiceAuditModule().then(({ auditGatewayServiceConfig }) =>
        auditGatewayServiceConfig({
          env: process.env,
          command,
        }),
      )
    : { ok: true, issues: [] satisfies ServiceConfigAudit["issues"] };
  const {
    mergedDaemonEnv,
    cliCfg,
    daemonCfg,
    cliConfigSummary,
    daemonConfigSummary,
    configMismatch,
  } = await loadDaemonConfigContext(command?.environment, { deep: opts.deep });
  const { gateway, daemonPort, cliPort, probeUrlOverride } = await resolveGatewayStatusSummary({
    cliCfg,
    daemonCfg,
    mergedDaemonEnv,
    commandProgramArguments: command?.programArguments,
    rpcUrlOverride: opts.rpc.url,
  });
  const shouldInspectLocalGateway = daemonCfg.gateway?.mode !== "remote" && !probeUrlOverride;
  const windowsFirewall =
    opts.deep === true && shouldInspectLocalGateway
      ? await inspectWindowsGatewayFirewall({
          bind: gateway.bindMode,
          mode: "quick",
          port: daemonPort,
          platform: process.platform,
        })
      : undefined;
  const { portStatus, portCliStatus } = await inspectDaemonPortStatuses({
    daemonPort,
    cliPort,
  });
  const establishedClients = await inspectEstablishedGatewayClients({
    daemonPort,
    deep: opts.deep,
    gatewayMode: daemonCfg.gateway?.mode,
  });

  const extraServices = opts.deep
    ? await loadDaemonInspectModule()
        .then(({ findExtraGatewayServices }) =>
          findExtraGatewayServices(process.env as Record<string, string | undefined>, {
            deep: true,
          }),
        )
        .catch(() => [])
    : [];
  const staleUpdateLaunchdJobs =
    opts.deep && process.platform === "darwin"
      ? await loadLaunchdModule()
          .then(({ findStaleOpenClawUpdateLaunchdJobs }) =>
            findStaleOpenClawUpdateLaunchdJobs(serviceEnv),
          )
          .catch(() => [])
      : [];

  const timeoutMs =
    parseStrictPositiveInteger(opts.rpc.timeout ?? undefined) ??
    Math.max(10_000, daemonCfg.gateway?.handshakeTimeoutMs ?? 0);

  const tlsEnabled = daemonCfg.gateway?.tls?.enabled === true;
  const shouldUseLocalTlsRuntime = opts.probe && !probeUrlOverride && tlsEnabled;
  const tlsRuntime = shouldUseLocalTlsRuntime
    ? await loadGatewayTlsModule().then(({ loadGatewayTlsRuntime }) =>
        loadGatewayTlsRuntime(daemonCfg.gateway?.tls),
      )
    : undefined;
  let daemonProbeAuth: { token?: string; password?: string } | undefined;
  let rpcAuthWarning: string | undefined;
  let allowRpcConfigCredentials = true;
  let skippedProbeAuthForDisabledExecSecretRef = false;
  if (opts.probe) {
    const probeMode = daemonCfg.gateway?.mode === "remote" ? "remote" : "local";
    const explicitAuth = {
      token: opts.rpc.token,
      password: opts.rpc.password,
    };
    const canResolveProbeAuth =
      opts.allowExecSecretRefs !== false ||
      !hasActiveGatewayExecProbeCredential({
        cfg: daemonCfg,
        env: mergedDaemonEnv as NodeJS.ProcessEnv,
        explicitAuth,
        mode: probeMode,
      });
    if (canResolveProbeAuth) {
      const probeAuthResolution = await loadGatewayProbeAuthModule().then(
        ({ resolveGatewayProbeAuthSafeWithSecretInputs }) =>
          resolveGatewayProbeAuthSafeWithSecretInputs({
            cfg: daemonCfg,
            mode: probeMode,
            env: mergedDaemonEnv as NodeJS.ProcessEnv,
            explicitAuth,
          }),
      );
      daemonProbeAuth = probeAuthResolution.auth;
      rpcAuthWarning = probeAuthResolution.warning;
    } else {
      allowRpcConfigCredentials = false;
      skippedProbeAuthForDisabledExecSecretRef = true;
      rpcAuthWarning =
        "Gateway probe auth skipped because gateway credentials use an exec SecretRef and exec SecretRefs are disabled for this status request.";
    }
  }

  const rpc = opts.probe
    ? await loadDaemonProbeModule().then(({ probeGatewayStatus }) =>
        probeGatewayStatus({
          url: gateway.probeUrl,
          token: daemonProbeAuth?.token,
          password: daemonProbeAuth?.password,
          config: daemonCfg,
          tlsFingerprint:
            shouldUseLocalTlsRuntime && tlsRuntime?.enabled
              ? tlsRuntime.fingerprintSha256
              : undefined,
          preauthHandshakeTimeoutMs: daemonCfg.gateway?.handshakeTimeoutMs,
          timeoutMs,
          json: opts.rpc.json,
          requireRpc: opts.requireRpc,
          allowRpcConfigCredentials,
          configPath: daemonConfigSummary.path,
        }),
      )
    : undefined;
  if (rpc?.ok && !skippedProbeAuthForDisabledExecSecretRef) {
    rpcAuthWarning = undefined;
  }
  const health =
    opts.probe && loaded && rpc?.ok !== true
      ? await loadRestartHealthModule()
          .then(({ inspectGatewayRestart }) =>
            inspectGatewayRestart({
              service,
              port: daemonPort,
              env: serviceEnv,
            }),
          )
          .catch(() => undefined)
      : undefined;
  const gatewayVersion = opts.probe
    ? ((rpc && "server" in rpc ? rpc.server?.version : undefined) ??
      (rpc && "version" in rpc ? rpc.version : undefined) ??
      null)
    : undefined;

  let lastError: string | undefined;
  if (
    shouldInspectLocalGateway &&
    loaded &&
    runtime?.status === "running" &&
    portStatus &&
    (portStatus.status !== "busy" || rpc?.ok === false)
  ) {
    lastError =
      (await readLastGatewayErrorLine(mergedDaemonEnv as NodeJS.ProcessEnv, {
        requirePatternMatch: portStatus.status === "busy",
      })) ?? undefined;
  }

  // Plugin version drift detection.
  // Compares active official external plugins against the *running* local
  // gateway version reported by the probe handshake, falling back to the
  // invoking CLI VERSION only when no gateway version is available. Reading
  // records with the merged daemon environment inspects the managed service's
  // profile/state dir, so remote/explicit URL probes need remote-owned
  // diagnostics instead.
  // Best-effort: unreadable install records omit this advisory report.
  let pluginVersionDrift: PluginVersionDriftReport | undefined;
  if (shouldInspectLocalGateway) {
    try {
      const installRecords = await loadInstalledPluginIndexInstallRecords({
        env: mergedDaemonEnv as NodeJS.ProcessEnv,
      });
      pluginVersionDrift = detectPluginVersionDrift({
        gatewayVersion: gatewayVersion ?? VERSION,
        installRecords,
        config: daemonCfg,
      });
    } catch {
      pluginVersionDrift = undefined;
    }
  }

  return {
    cli: resolveCliStatusSummary(),
    logFile: resolveConfiguredLogFilePath(cliCfg),
    service: {
      label: service.label,
      loaded,
      loadedText: service.loadedText,
      notLoadedText: service.notLoadedText,
      command,
      runtime,
      configAudit,
      ...(restartHandoff ? { restartHandoff } : {}),
      ...(staleUpdateLaunchdJobs.length > 0 ? { staleUpdateLaunchdJobs } : {}),
    },
    config: {
      cli: cliConfigSummary,
      daemon: daemonConfigSummary,
      ...(configMismatch ? { mismatch: true } : {}),
    },
    gateway: {
      ...gateway,
      ...(windowsFirewall?.applies ? { windowsFirewall } : {}),
      ...(opts.probe
        ? {
            version: gatewayVersion,
          }
        : {}),
    },
    port: portStatus,
    ...(portCliStatus ? { portCli: portCliStatus } : {}),
    ...(establishedClients ? { connections: establishedClients } : {}),
    lastError,
    ...(rpc
      ? {
          rpc: {
            ...rpc,
            url: gateway.probeUrl,
            ...(rpcAuthWarning ? { authWarning: rpcAuthWarning } : {}),
          },
        }
      : {}),
    ...(health
      ? {
          health: {
            healthy: health.healthy,
            staleGatewayPids: health.staleGatewayPids,
          },
        }
      : {}),
    extraServices,
    ...(pluginVersionDrift ? { pluginVersionDrift } : {}),
  };
}

export function renderPortDiagnosticsForCli(status: DaemonStatus, rpcOk?: boolean): string[] {
  if (!status.port || !shouldReportPortUsage(status.port.status, rpcOk)) {
    return [];
  }
  return formatPortDiagnostics({
    port: status.port.port,
    status: status.port.status,
    listeners: status.port.listeners,
    hints: status.port.hints,
  });
}

export function resolvePortListeningAddresses(status: DaemonStatus): string[] {
  const addrs = Array.from(
    new Set(
      status.port?.listeners
        ?.map((l) => (l.address ? normalizeListenerAddress(l.address) : ""))
        .filter((v): v is string => Boolean(v)) ?? [],
    ),
  );
  return addrs;
}
