import {
  createConfigIO,
  resolveConfigPath,
  resolveGatewayPort,
  resolveStateDir,
} from "../../config/config.js";
import type { BridgeBindMode, GatewayControlUiConfig } from "../../config/types.js";
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";
import { findExtraGatewayServices } from "../../daemon/inspect.js";
import { findLegacyGatewayServices } from "../../daemon/legacy.js";
import { resolveGatewayService } from "../../daemon/service.js";
import type { ServiceConfigAudit } from "../../daemon/service-audit.js";
import { auditGatewayServiceConfig } from "../../daemon/service-audit.js";
import { resolveGatewayBindHost } from "../../gateway/net.js";
import {
  formatPortDiagnostics,
  inspectPortUsage,
  type PortListener,
  type PortUsageStatus,
} from "../../infra/ports.js";
import { pickPrimaryTailnetIPv4 } from "../../infra/tailnet.js";
import { probeGatewayStatus } from "./probe.js";
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
  bindMode: BridgeBindMode;
  bindHost: string;
  customBindHost?: string;
  port: number;
  portSource: "service args" | "env/config";
  probeUrl: string;
  probeNote?: string;
};

export type DaemonStatus = {
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

function shouldReportPortUsage(status: PortUsageStatus | undefined, rpcOk?: boolean) {
  if (status !== "busy") return false;
  if (rpcOk === true) return false;
  return true;
}

export async function gatherDaemonStatus(
  opts: {
    rpc: GatewayRpcOpts;
    probe: boolean;
    deep?: boolean;
  } & FindExtraGatewayServicesOptions,
): Promise<DaemonStatus> {
  const service = resolveGatewayService();
  const [loaded, command, runtime] = await Promise.all([
    service.isLoaded({ env: process.env }).catch(() => false),
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

  const cliConfigPath = resolveConfigPath(process.env, resolveStateDir(process.env));
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
    ...(daemonSnapshot?.issues?.length ? { issues: daemonSnapshot.issues } : {}),
    controlUi: daemonCfg.gateway?.controlUi,
  };
  const configMismatch = cliConfigSummary.path !== daemonConfigSummary.path;

  const portFromArgs = parsePortFromArgs(command?.programArguments);
  const daemonPort = portFromArgs ?? resolveGatewayPort(daemonCfg, mergedDaemonEnv);
  const portSource: GatewayStatusSummary["portSource"] = portFromArgs
    ? "service args"
    : "env/config";

  const bindMode = (daemonCfg.gateway?.bind ?? "loopback") as
    | "auto"
    | "lan"
    | "loopback"
    | "custom";
  const customBindHost = daemonCfg.gateway?.customBindHost;
  const bindHost = await resolveGatewayBindHost(bindMode, customBindHost);
  const tailnetIPv4 = pickPrimaryTailnetIPv4();
  const probeHost = pickProbeHostForBind(bindMode, tailnetIPv4, customBindHost);
  const probeUrlOverride =
    typeof opts.rpc.url === "string" && opts.rpc.url.trim().length > 0 ? opts.rpc.url.trim() : null;
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

  const legacyServices = await findLegacyGatewayServices(
    process.env as Record<string, string | undefined>,
  ).catch(() => []);
  const extraServices = await findExtraGatewayServices(
    process.env as Record<string, string | undefined>,
    { deep: Boolean(opts.deep) },
  ).catch(() => []);

  const timeoutMsRaw = Number.parseInt(String(opts.rpc.timeout ?? "10000"), 10);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 10_000;

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
  if (loaded && runtime?.status === "running" && portStatus && portStatus.status !== "busy") {
    lastError = (await readLastGatewayErrorLine(mergedDaemonEnv as NodeJS.ProcessEnv)) ?? undefined;
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
      customBindHost,
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

export function renderPortDiagnosticsForCli(status: DaemonStatus, rpcOk?: boolean): string[] {
  if (!status.port || !shouldReportPortUsage(status.port.status, rpcOk)) return [];
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
