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
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";
import type { ServiceConfigAudit } from "../../daemon/service-audit.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { trimToUndefined } from "../../gateway/credentials.js";
import {
  inspectBestEffortPrimaryTailnetIPv4,
  resolveBestEffortGatewayBindHostForDisplay,
} from "../../infra/network-discovery-display.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import {
  formatPortDiagnostics,
  inspectPortUsage,
  type PortListener,
  type PortUsageStatus,
} from "../../infra/ports.js";
import { resolveConfiguredLogFilePath } from "../../logging/log-file-path.js";
import { normalizeListenerAddress, parsePortFromArgs, pickProbeHostForBind } from "./shared.js";
import type { GatewayRpcOpts } from "./types.js";

type ConfigSummary = {
  path: string;
  exists: boolean;
  valid: boolean;
  issues?: Array<{ path: string; message: string }>;
  controlUi?: GatewayControlUiConfig;
};

type GatewayStatusSummary = {
  bindMode: GatewayBindMode;
  bindHost: string;
  customBindHost?: string;
  port: number;
  portSource: "service args" | "env/config";
  probeUrl: string;
  probeNote?: string;
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

type ResolvedGatewayStatus = {
  gateway: GatewayStatusSummary;
  daemonPort: number;
  cliPort: number;
  probeUrlOverride: string | null;
};

let gatewayProbeAuthModulePromise:
  | Promise<typeof import("../../gateway/probe-auth.js")>
  | undefined;
let daemonInspectModulePromise: Promise<typeof import("../../daemon/inspect.js")> | undefined;
let serviceAuditModulePromise: Promise<typeof import("../../daemon/service-audit.js")> | undefined;
let gatewayTlsModulePromise: Promise<typeof import("../../infra/tls/gateway.js")> | undefined;
let daemonProbeModulePromise: Promise<typeof import("./probe.js")> | undefined;
let restartHealthModulePromise: Promise<typeof import("./restart-health.js")> | undefined;

function loadGatewayProbeAuthModule() {
  gatewayProbeAuthModulePromise ??= import("../../gateway/probe-auth.js");
  return gatewayProbeAuthModulePromise;
}

function loadDaemonInspectModule() {
  daemonInspectModulePromise ??= import("../../daemon/inspect.js");
  return daemonInspectModulePromise;
}

function loadServiceAuditModule() {
  serviceAuditModulePromise ??= import("../../daemon/service-audit.js");
  return serviceAuditModulePromise;
}

function loadGatewayTlsModule() {
  gatewayTlsModulePromise ??= import("../../infra/tls/gateway.js");
  return gatewayTlsModulePromise;
}

function loadDaemonProbeModule() {
  daemonProbeModulePromise ??= import("./probe.js");
  return daemonProbeModulePromise;
}

function loadRestartHealthModule() {
  restartHealthModulePromise ??= import("./restart-health.js");
  return restartHealthModulePromise;
}

function resolveSnapshotRuntimeConfig(snapshot: ConfigFileSnapshot | null): OpenClawConfig | null {
  if (!snapshot?.valid || !snapshot.runtimeConfig) {
    return null;
  }
  return snapshot.runtimeConfig;
}

function appendProbeNote(
  existing: string | undefined,
  extra: string | undefined,
): string | undefined {
  const values = [existing, extra].filter((value): value is string => Boolean(value?.trim()));
  if (values.length === 0) {
    return undefined;
  }
  return [...new Set(values)].join(" ");
}
export type DaemonStatus = {
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
    kind?: "connect" | "read";
    capability?: string;
    auth?: {
      role?: string | null;
      scopes?: string[];
      capability?: string;
    };
    error?: string;
    url?: string;
    authWarning?: string;
  };
  health?: {
    healthy: boolean;
    staleGatewayPids: number[];
  };
  extraServices: Array<{ label: string; detail: string; scope: string }>;
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

async function loadDaemonConfigContext(
  serviceEnv?: Record<string, string>,
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

  const cliIO = createConfigIO({ env: process.env, configPath: cliConfigPath });
  const sharesDaemonConfigContext = !serviceEnv && cliConfigPath === daemonConfigPath;
  const daemonIO = sharesDaemonConfigContext
    ? cliIO
    : createConfigIO({
        env: mergedDaemonEnv,
        configPath: daemonConfigPath,
      });

  const cliSnapshotPromise = cliIO.readConfigFileSnapshot().catch(() => null);
  const daemonSnapshotPromise = sharesDaemonConfigContext
    ? cliSnapshotPromise
    : daemonIO.readConfigFileSnapshot().catch(() => null);
  const [cliSnapshot, daemonSnapshot] = await Promise.all([
    cliSnapshotPromise,
    daemonSnapshotPromise,
  ]);
  const cliCfg = resolveSnapshotRuntimeConfig(cliSnapshot) ?? cliIO.loadConfig();
  const daemonCfg =
    sharesDaemonConfigContext && cliSnapshot === daemonSnapshot
      ? cliCfg
      : (resolveSnapshotRuntimeConfig(daemonSnapshot) ?? daemonIO.loadConfig());

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
    ...(daemonSnapshot?.issues?.length ? { issues: daemonSnapshot.issues } : {}),
    controlUi: daemonCfg.gateway?.controlUi,
  };

  return {
    mergedDaemonEnv,
    cliCfg,
    daemonCfg,
    cliConfigSummary,
    daemonConfigSummary,
    configMismatch: cliConfigSummary.path !== daemonConfigSummary.path,
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
  const scheme = params.daemonCfg.gateway?.tls?.enabled === true ? "wss" : "ws";
  const probeUrl = probeUrlOverride ?? `${scheme}://${probeHost}:${daemonPort}`;
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
      port: daemonPort,
      portSource,
      probeUrl,
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

export async function gatherDaemonStatus(
  opts: {
    rpc: GatewayRpcOpts;
    probe: boolean;
    requireRpc?: boolean;
    deep?: boolean;
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
    service.readRuntime(serviceEnv).catch((err) => ({ status: "unknown", detail: String(err) })),
  ]);
  const configAudit = command
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
  } = await loadDaemonConfigContext(command?.environment);
  const { gateway, daemonPort, cliPort, probeUrlOverride } = await resolveGatewayStatusSummary({
    cliCfg,
    daemonCfg,
    mergedDaemonEnv,
    commandProgramArguments: command?.programArguments,
    rpcUrlOverride: opts.rpc.url,
  });
  const { portStatus, portCliStatus } = await inspectDaemonPortStatuses({
    daemonPort,
    cliPort,
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

  const timeoutMs = parseStrictPositiveInteger(opts.rpc.timeout ?? "10000") ?? 10_000;

  const tlsEnabled = daemonCfg.gateway?.tls?.enabled === true;
  const shouldUseLocalTlsRuntime = opts.probe && !probeUrlOverride && tlsEnabled;
  const tlsRuntime = shouldUseLocalTlsRuntime
    ? await loadGatewayTlsModule().then(({ loadGatewayTlsRuntime }) =>
        loadGatewayTlsRuntime(daemonCfg.gateway?.tls),
      )
    : undefined;
  let daemonProbeAuth: { token?: string; password?: string } | undefined;
  let rpcAuthWarning: string | undefined;
  if (opts.probe) {
    const probeMode = daemonCfg.gateway?.mode === "remote" ? "remote" : "local";
    const probeAuthResolution = await loadGatewayProbeAuthModule().then(
      ({ resolveGatewayProbeAuthSafeWithSecretInputs }) =>
        resolveGatewayProbeAuthSafeWithSecretInputs({
          cfg: daemonCfg,
          mode: probeMode,
          env: mergedDaemonEnv as NodeJS.ProcessEnv,
          explicitAuth: {
            token: opts.rpc.token,
            password: opts.rpc.password,
          },
        }),
    );
    daemonProbeAuth = probeAuthResolution.auth;
    rpcAuthWarning = probeAuthResolution.warning;
  }

  const rpc = opts.probe
    ? await loadDaemonProbeModule().then(({ probeGatewayStatus }) =>
        probeGatewayStatus({
          url: gateway.probeUrl,
          token: daemonProbeAuth?.token,
          password: daemonProbeAuth?.password,
          tlsFingerprint:
            shouldUseLocalTlsRuntime && tlsRuntime?.enabled
              ? tlsRuntime.fingerprintSha256
              : undefined,
          timeoutMs,
          json: opts.rpc.json,
          requireRpc: opts.requireRpc,
          configPath: daemonConfigSummary.path,
        }),
      )
    : undefined;
  if (rpc?.ok) {
    rpcAuthWarning = undefined;
  }
  const health =
    opts.probe && loaded
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

  let lastError: string | undefined;
  if (loaded && runtime?.status === "running" && portStatus && portStatus.status !== "busy") {
    lastError = (await readLastGatewayErrorLine(mergedDaemonEnv as NodeJS.ProcessEnv)) ?? undefined;
  }

  return {
    logFile: resolveConfiguredLogFilePath(cliCfg),
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
    gateway,
    port: portStatus,
    ...(portCliStatus ? { portCli: portCliStatus } : {}),
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
