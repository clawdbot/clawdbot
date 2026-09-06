// Collects daemon status from service files, config snapshots, ports, probes, and plugin drift.
import fs from "node:fs/promises";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import type { classifyGatewayConnectFailure } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  isDefaultInstallIdentity,
  resolveConfigPath,
  resolveStateDir,
} from "../../config/paths.js";
import type {
  OpenClawConfig,
  ConfigFileSnapshot,
  GatewayControlUiConfig,
} from "../../config/types.js";
import { resolveSecretInputRef } from "../../config/types.secrets.js";
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import { inspectGatewayHeapLimit, type GatewayHeapLimitReport } from "../../daemon/gateway-heap.js";
import type { ExtraGatewayService, FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";
import type { StaleOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import type { ServiceConfigAudit } from "../../daemon/service-audit.js";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceLoadState,
} from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { gatewaySecretInputPathCanWin } from "../../gateway/credentials-secret-inputs.js";
import type { HostDesktopStatus } from "../../gateway/desktop/host-source.js";
import { resolveGatewayRequiredListenHosts } from "../../gateway/net.js";
import { resolveGatewayProbeCredentialConfig } from "../../gateway/probe-auth.js";
import {
  ALL_GATEWAY_SECRET_INPUT_PATHS,
  readGatewaySecretInputValue,
} from "../../gateway/secret-input-paths.js";
import { isGatewayExternallySupervised } from "../../infra/gateway-supervision.js";
import { formatPortDiagnostics } from "../../infra/ports-format.js";
import { inspectPortConnections } from "../../infra/ports-inspect.js";
import type { PortConnection } from "../../infra/ports-types.js";
import {
  readGatewayRestartHandoffSync,
  type GatewayRestartHandoff,
} from "../../infra/restart-handoff.js";
import { inspectWindowsGatewayFirewall } from "../../infra/windows-gateway-firewall-diagnostics.js";
import { resolveConfiguredLogFilePath } from "../../logging/log-file-path.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-record-reader.js";
import {
  detectPluginVersionDrift,
  hasOfficialPluginVersionCandidates,
  type PluginVersionDriftReport,
  type PluginVersionRestartReadiness,
} from "../../plugins/plugin-version-drift.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import { VERSION } from "../../version.js";
import { resolveGatewayLocalPortOverride } from "../gateway-port-option.js";
import { parseTimeoutMsWithFallback } from "../parse-timeout.js";
import { normalizeListenerAddress } from "./shared.js";
import {
  inspectDaemonPortStatuses,
  resolveGatewayStatusSummary,
  type GatewayStatusSummary,
  type PortStatusSummary,
} from "./status.gateway.js";
import type { GatewayRpcOpts } from "./types.js";

type ConfigSummary = {
  path: string;
  exists: boolean;
  valid: boolean;
  issues?: Array<{ path: string; message: string }>;
  warnings?: ConfigFileSnapshot["warnings"];
  controlUi?: GatewayControlUiConfig;
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

type CliStatusSummary = {
  version: string;
  entrypoint?: string;
};

type GatewayConnectFailureKind = ReturnType<typeof classifyGatewayConnectFailure>["kind"];

const loadGatewayProbeAuthModule = createLazyPromise(() => import("../../gateway/probe-auth.js"));
const loadConfigIoRuntime = createLazyPromise(() => import("../../config/io.runtime.js"));
const loadDaemonInspectModule = createLazyPromise(() => import("../../daemon/inspect.js"));
const loadLaunchdModule = createLazyPromise(() => import("../../daemon/launchd.js"));
const loadServiceAuditModule = createLazyPromise(() => import("../../daemon/service-audit.js"));
const loadGatewayTlsModule = createLazyPromise(() => import("../../infra/tls/gateway.js"));
const loadDaemonProbeModule = createLazyPromise(() => import("./probe.js"));
const loadRestartHealthModule = createLazyPromise(() => import("./restart-health.js"));

async function readFastStatusConfig(configPath: string): Promise<StatusConfigRead | null> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      return null;
    }
    return {
      summary: { path: configPath, exists: false, valid: true },
      cfg: {},
      mode: "fast",
    };
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

  const cfg: OpenClawConfig = asNonArrayRecord(parsed);
  // Includes and environment expansion require the full config owner.
  if (raw.includes("$include") || raw.includes("${") || Object.hasOwn(cfg, "env")) {
    return null;
  }

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
  const { createConfigIO } = await loadConfigIoRuntime();
  const io = createConfigIO({
    env: params.env,
    configPath: params.configPath,
    observe: false,
    pluginValidation: params.pluginValidation ?? "skip",
    logger: {
      error: () => {},
      warn: () => {},
    },
  });
  const snapshot = await io.readConfigFileSnapshot().catch(() => null);
  const cfg = (snapshot?.valid && snapshot.runtimeConfig) || io.loadConfig();
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

export type DaemonStatus = {
  cli?: CliStatusSummary;
  logFile?: string;
  service: {
    label: string;
    loaded: boolean | null;
    loadState: GatewayServiceLoadState;
    loadedText: string;
    notLoadedText: string;
    targetRole?: "target" | "diagnostic-only";
    command?: GatewayServiceCommandConfig | null;
    runtime?: GatewayServiceRuntime;
    configAudit?: ServiceConfigAudit;
    gatewayHeap?: GatewayHeapLimitReport;
    restartHandoff?: GatewayRestartHandoff;
    staleUpdateLaunchdJobs?: StaleOpenClawUpdateLaunchdJob[];
  };
  config?: {
    cli: ConfigSummary;
    daemon?: ConfigSummary;
    mismatch?: boolean;
  };
  gateway?: GatewayStatusSummary;
  hostDesktop?: HostDesktopStatus;
  port?: PortStatusSummary;
  portCli?: PortStatusSummary;
  connections?: {
    port: number;
    established: PortConnection[];
  };
  lastError?: string;
  rpc?: {
    ok: boolean;
    gatewayReached?: true;
    kind?: "connect" | "read";
    capability?: string;
    auth?: {
      role?: string | null;
      scopes?: string[];
      capability?: string;
    };
    server?: {
      version?: string | null;
      buildId?: string | null;
      connId?: string | null;
    };
    version?: string | null;
    error?: string;
    connectFailure?: {
      kind: GatewayConnectFailureKind;
      detailCode?: string;
    };
    url?: string;
    authWarning?: string;
  };
  health?: {
    healthy: boolean;
    staleGatewayPids: number[];
  };
  extraServices: ExtraGatewayService[];
  /**
   * Plugin version drift report. Surfaces active official external plugins
   * whose installed version does not match the running gateway version, which
   * can happen after `npm install -g openclaw@<v>` updates the gateway binary
   * without a corresponding `openclaw plugins update`.
   */
  pluginVersionDrift?: PluginVersionDriftReport;
  /** Doctor-only comparison against the installed service package a restart will load. */
  pluginVersionRestartReadiness?: PluginVersionRestartReadiness;
};

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
    ...process.env,
    ...(serviceEnv ?? undefined),
  } satisfies Record<string, string | undefined>;

  const cliConfigPath = resolveConfigPath(process.env, resolveStateDir(process.env));
  const daemonConfigPath = resolveConfigPath(mergedDaemonEnv, resolveStateDir(mergedDaemonEnv));
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
        env: mergedDaemonEnv,
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
        // Remote probe config suppresses ambient credentials across auth types.
        // Mirror that owner here so env auth cannot hide a winning exec ref.
        remoteTokenFallback: "remote-only",
        remotePasswordFallback: "remote-only",
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
    pluginVersionTarget?: "running" | "restart";
  } & FindExtraGatewayServicesOptions,
): Promise<DaemonStatus> {
  const localPortOverride = resolveGatewayLocalPortOverride(opts.rpc);
  const timeoutMs = parseTimeoutMsWithFallback(opts.rpc.timeout, 10_000, {
    invalidType: "error",
  });
  const service = resolveGatewayService();
  const serviceState = await readGatewayServiceState(service, {
    env: process.env,
    timeoutMs,
  });
  const { command, env: serviceEnv, loadState, runtime } = serviceState;
  const loaded = loadState.status === "loaded";
  // An explicit local port or separate process context does not select the
  // native service. Keep that service visible without borrowing its target or auth.
  const useNativeServiceTargetContext =
    localPortOverride === undefined &&
    isDefaultInstallIdentity(process.env) &&
    !isGatewayExternallySupervised(process.env);
  const targetServiceCommand = useNativeServiceTargetContext ? command : null;
  const restartHandoff = opts.deep ? readGatewayRestartHandoffSync(serviceEnv) : null;
  const configAudit: ServiceConfigAudit = await loadServiceAuditModule().then(
    ({ auditGatewayServiceConfig }) =>
      auditGatewayServiceConfig({
        env: process.env,
        command,
        timeoutMs,
      }),
  );
  const {
    mergedDaemonEnv,
    cliCfg,
    daemonCfg,
    cliConfigSummary,
    daemonConfigSummary,
    configMismatch,
  } = await loadDaemonConfigContext(targetServiceCommand?.environment, { deep: opts.deep });
  const { gateway, daemonPort, cliPort, probeUrl, probeUrlOverride } =
    await resolveGatewayStatusSummary({
      cliCfg,
      daemonCfg,
      mergedDaemonEnv,
      commandProgramArguments: targetServiceCommand?.programArguments,
      rpcUrlOverride: opts.rpc.url,
      localPortOverride,
    });
  const probeMode =
    localPortOverride === undefined && daemonCfg.gateway?.mode === "remote" ? "remote" : "local";
  const serviceTargetsProbe = useNativeServiceTargetContext && !probeUrlOverride;
  const shouldInspectLocalGateway = probeMode === "local" && !probeUrlOverride;
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
    daemonBindHost: gateway.bindHost,
  });
  const establishedClients = await inspectEstablishedGatewayClients({
    daemonPort,
    deep: opts.deep,
    gatewayMode: probeMode,
  });

  const extraServices = opts.deep
    ? await loadDaemonInspectModule()
        .then(({ findExtraGatewayServices }) =>
          findExtraGatewayServices(process.env, {
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

  const tlsEnabled = daemonCfg.gateway?.tls?.enabled === true;
  const localCertificate =
    opts.probe && !probeUrlOverride && tlsEnabled
      ? await loadGatewayTlsModule().then(({ inspectGatewayTlsCertificate }) =>
          inspectGatewayTlsCertificate(daemonCfg.gateway?.tls),
        )
      : undefined;
  let daemonProbeAuth: { token?: string; password?: string } | undefined;
  let rpcAuthWarning: string | undefined;
  let allowRpcConfigCredentials = true;
  let skippedProbeAuthForDisabledExecSecretRef = false;
  if (opts.probe) {
    const explicitAuth = {
      token: opts.rpc.token,
      password: opts.rpc.password,
    };
    const canResolveProbeAuth =
      opts.allowExecSecretRefs !== false ||
      !hasActiveGatewayExecProbeCredential({
        cfg: daemonCfg,
        env: mergedDaemonEnv,
        explicitAuth,
        mode: probeMode,
      });
    if (canResolveProbeAuth) {
      const probeAuthResolution = await loadGatewayProbeAuthModule().then(
        ({ resolveGatewayProbeAuthSafeWithSecretInputs }) =>
          resolveGatewayProbeAuthSafeWithSecretInputs({
            cfg: daemonCfg,
            mode: probeMode,
            env: mergedDaemonEnv,
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
          url: probeUrl,
          localPortOverride,
          token: daemonProbeAuth?.token,
          password: daemonProbeAuth?.password,
          config: daemonCfg,
          tlsFingerprint: localCertificate?.ok
            ? localCertificate.value.fingerprintSha256
            : undefined,
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
    opts.probe && serviceTargetsProbe && loaded && rpc?.ok !== true
      ? await loadRestartHealthModule()
          .then(({ inspectGatewayRestart }) =>
            inspectGatewayRestart({
              service,
              port: daemonPort,
              env: serviceEnv,
              probeHosts: resolveGatewayRequiredListenHosts(gateway.bindHost),
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
      (await readLastGatewayErrorLine(mergedDaemonEnv, {
        requirePatternMatch: portStatus.status === "busy",
      })) ?? undefined;
  }

  // Plugin version drift detection. Status compares with the running Gateway;
  // Doctor can request the installed service version that a restart will load.
  // Reading records with the merged daemon environment inspects the managed service's
  // profile/state dir, so remote/explicit URL probes need remote-owned
  // diagnostics instead.
  // Status omits unreadable advisory data; Doctor reports restart readiness as unresolved.
  // Registry repair lookups belong to deep-status and Doctor command owners;
  // readiness, support, and triage must not wait for the public registry.
  let pluginVersionDrift: PluginVersionDriftReport | undefined;
  let pluginVersionRestartReadiness: PluginVersionRestartReadiness | undefined;
  if (shouldInspectLocalGateway) {
    const loadInstallRecords = () =>
      loadInstalledPluginIndexInstallRecords({
        env: mergedDaemonEnv,
      });
    try {
      if (opts.pluginVersionTarget === "restart") {
        const runningGatewayVersion = gatewayVersion ?? undefined;
        if (!useNativeServiceTargetContext || (!targetServiceCommand && !loaded)) {
          // Only the authoritative loaded native service can define restart readiness.
        } else {
          const installRecords = await loadInstallRecords();
          if (hasOfficialPluginVersionCandidates({ installRecords, config: daemonCfg })) {
            if (!targetServiceCommand) {
              pluginVersionRestartReadiness = {
                status: "unresolved",
                reason:
                  "Gateway service command is unavailable, so the post-restart OpenClaw version is unknown.",
                ...(runningGatewayVersion ? { runningGatewayVersion } : {}),
              };
            } else {
              const layout = await summarizeGatewayServiceLayout(targetServiceCommand);
              if (!layout?.packageVersion) {
                pluginVersionRestartReadiness = {
                  status: "unresolved",
                  reason:
                    "Gateway service package version is unavailable, so the post-restart OpenClaw version is unknown.",
                  ...(runningGatewayVersion ? { runningGatewayVersion } : {}),
                };
              } else {
                const report = detectPluginVersionDrift({
                  gatewayVersion: layout.packageVersion,
                  installRecords,
                  config: daemonCfg,
                });
                pluginVersionRestartReadiness = {
                  status: "resolved",
                  report,
                  ...(runningGatewayVersion ? { runningGatewayVersion } : {}),
                };
              }
            }
          }
        }
      } else {
        const installRecords = await loadInstallRecords();
        pluginVersionDrift = detectPluginVersionDrift({
          gatewayVersion: gatewayVersion ?? VERSION,
          installRecords,
          config: daemonCfg,
        });
      }
    } catch {
      if (opts.pluginVersionTarget === "restart") {
        pluginVersionRestartReadiness = {
          status: "unresolved",
          reason:
            "Plugin restart readiness could not be inspected, so post-restart compatibility is unknown.",
          ...(gatewayVersion ? { runningGatewayVersion: gatewayVersion } : {}),
        };
      } else {
        pluginVersionDrift = undefined;
      }
    }
  }

  const hostDesktop = await (
    await import("../../gateway/desktop/host-source.js")
  ).inspectHostDesktop({ config: daemonCfg.desktop?.host });

  return {
    cli: resolveCliStatusSummary(),
    logFile: resolveConfiguredLogFilePath(cliCfg),
    service: {
      label: service.label,
      loaded: loadState.status === "unknown" ? null : loaded,
      loadState,
      loadedText: service.loadedText,
      notLoadedText: service.notLoadedText,
      targetRole: serviceTargetsProbe ? "target" : "diagnostic-only",
      command,
      runtime: runtime?.inspectionFailure
        ? {
            ...runtime,
            detail: `${runtime.detail}; retry with openclaw gateway status --deep`,
          }
        : runtime,
      configAudit,
      ...(command
        ? {
            gatewayHeap: inspectGatewayHeapLimit(
              command.environment?.NODE_OPTIONS,
              {},
              command.programArguments,
            ),
          }
        : {}),
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
    hostDesktop: hostDesktop.status,
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
    ...(pluginVersionRestartReadiness ? { pluginVersionRestartReadiness } : {}),
  };
}

export function renderPortDiagnosticsForCli({ port }: DaemonStatus, rpcOk?: boolean): string[] {
  if (!port || port.status === undefined || port.status === "free" || rpcOk === true) {
    return [];
  }
  return formatPortDiagnostics({
    port: port.port,
    status: port.status,
    listeners: port.listeners,
    hints: port.hints,
  });
}

export function resolvePortListeningAddresses(status: DaemonStatus): string[] {
  return Array.from(
    new Set(
      status.port?.listeners
        ?.map((l) => (l.address ? normalizeListenerAddress(l.address) : ""))
        .filter((v): v is string => Boolean(v)) ?? [],
    ),
  );
}
