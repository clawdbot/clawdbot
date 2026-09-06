// Gateway target projection and port diagnostics for daemon status.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveGatewayPort } from "../../config/paths.js";
import type { GatewayBindMode, OpenClawConfig } from "../../config/types.js";
import { projectGatewayUrlForDiagnostics } from "../../gateway/connection-details.js";
import { resolveAdvertisedControlUiLinks } from "../../gateway/control-ui-links.js";
import { trimToUndefined } from "../../gateway/credentials.js";
import { resolveGatewayRequiredListenHosts } from "../../gateway/net.js";
import {
  inspectBestEffortPrimaryTailnetIPv4,
  resolveBestEffortGatewayBindHostForDisplay,
} from "../../infra/network-discovery-display.js";
import { inspectPortUsage, inspectPortUsages } from "../../infra/ports-inspect.js";
import type { PortListener, PortUsageStatus } from "../../infra/ports-types.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import type { WindowsGatewayFirewallDiagnostic } from "../../infra/windows-gateway-firewall-diagnostics.js";
import { pickProbeHostForBind } from "./shared.js";

export type GatewayStatusSummary = {
  bindMode: GatewayBindMode;
  bindHost: string;
  customBindHost?: string;
  tlsEnabled?: boolean;
  port: number;
  portSource: "cli" | "service args" | "env/config";
  probeUrl: string;
  controlUiLinks?: { httpUrl: string; wsUrl: string };
  probeNote?: string;
  version?: string | null;
  windowsFirewall?: WindowsGatewayFirewallDiagnostic;
};

export type PortStatusSummary = {
  port: number;
  status: PortUsageStatus;
  listeners: PortListener[];
  hints: string[];
};

type ResolvedGatewayStatus = {
  gateway: GatewayStatusSummary;
  daemonPort: number;
  cliPort: number;
  probeUrl: string;
  probeUrlOverride: string | null;
};

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

export async function resolveGatewayStatusSummary(params: {
  daemonCfg: OpenClawConfig;
  cliCfg: OpenClawConfig;
  mergedDaemonEnv: Record<string, string | undefined>;
  commandProgramArguments?: string[];
  rpcUrlOverride?: string;
  localPortOverride?: number;
}): Promise<ResolvedGatewayStatus> {
  const portFromArgs = parseTcpPortFromArgs(params.commandProgramArguments);
  const daemonPort =
    params.localPortOverride ??
    portFromArgs ??
    resolveGatewayPort(params.daemonCfg, params.mergedDaemonEnv);
  const portSource: GatewayStatusSummary["portSource"] =
    params.localPortOverride !== undefined ? "cli" : portFromArgs ? "service args" : "env/config";
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
  const probeHost =
    params.localPortOverride !== undefined
      ? "127.0.0.1"
      : pickProbeHostForBind(bindMode, tailnetIPv4, customBindHost);
  const probeUrlOverride = trimToUndefined(params.rpcUrlOverride) ?? null;
  const tlsEnabled = params.daemonCfg.gateway?.tls?.enabled === true;
  const scheme = tlsEnabled ? "wss" : "ws";
  const probeUrl = probeUrlOverride ?? `${scheme}://${probeHost}:${daemonPort}`;
  const diagnosticProbeUrl = projectGatewayUrlForDiagnostics(probeUrl);
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
      probeUrl: diagnosticProbeUrl,
      ...(controlUiLinks ? { controlUiLinks } : {}),
      ...(probeNote ? { probeNote } : {}),
    },
    daemonPort,
    cliPort: resolveGatewayPort(params.cliCfg, process.env),
    probeUrl,
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

export async function inspectDaemonPortStatuses(params: {
  daemonPort: number;
  cliPort: number;
  daemonBindHost: string;
}): Promise<{ portStatus?: PortStatusSummary; portCliStatus?: PortStatusSummary }> {
  const daemonProbeHosts = resolveGatewayRequiredListenHosts(params.daemonBindHost);
  if (params.cliPort === params.daemonPort) {
    const portDiagnostics = await inspectPortUsage(params.daemonPort, {
      probeHosts: daemonProbeHosts,
    }).catch(() => null);
    return {
      portStatus: toPortStatusSummary(portDiagnostics),
      portCliStatus: undefined,
    };
  }
  const portDiagnosticsByPort = await inspectPortUsages([params.daemonPort, params.cliPort], {
    probeHostsByPort: new Map([[params.daemonPort, daemonProbeHosts]]),
  }).catch(() => new Map());
  return {
    portStatus: toPortStatusSummary(portDiagnosticsByPort.get(params.daemonPort) ?? null),
    portCliStatus: toPortStatusSummary(portDiagnosticsByPort.get(params.cliPort) ?? null),
  };
}
