// Collects raw data needed to render `openclaw status --all`.
// This file performs local read-only probes; formatting stays in report-line builders.

import { resolveNodeExecEligibility } from "../../agents/exec-defaults.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../../config/config.js";
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import { inspectPortUsage } from "../../infra/ports.js";
import { readRestartSentinel } from "../../infra/restart-sentinel.js";
import { buildPluginCompatibilityNotices } from "../../plugins/status.js";
import { buildWorkspaceSkillStatus } from "../../skills/discovery/status.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import { buildStatusAllOverviewRows } from "../status-overview-rows.ts";
import {
  buildStatusOverviewSurfaceFromOverview,
  type StatusOverviewSurface,
} from "../status-overview-surface.ts";
import {
  resolveStatusGatewayDiagnosticsSafe,
  resolveStatusGatewayHealthSafe,
  type resolveStatusServiceSummaries,
} from "../status-runtime-shared.ts";
import { formatUpdateRestartStatusValue } from "../status-update-restart.ts";
import { resolveStatusAllConnectionDetails } from "../status.gateway-connection.ts";
import type { NodeOnlyGatewayInfo } from "../status.node-mode.js";
import type { StatusScanOverviewResult } from "../status.scan-overview.ts";

type StatusServiceSummaries = Awaited<ReturnType<typeof resolveStatusServiceSummaries>>;
type StatusGatewayServiceSummary = StatusServiceSummaries[0];
type StatusNodeServiceSummary = StatusServiceSummaries[1];
type StatusGatewayHealthSafe = Awaited<ReturnType<typeof resolveStatusGatewayHealthSafe>>;
type ConfigFileSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshot>>;

type StatusAllProgress = {
  setLabel(label: string): void;
  tick(): void;
};

function resolveStatusAllConfigPath(path: string | null | undefined): string {
  const trimmed = path?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "(unknown config path)";
}

/** Collects local diagnosis inputs that are not part of the shared overview scan. */
async function resolveStatusAllLocalDiagnosis(params: {
  overview: StatusScanOverviewResult;
  progress: StatusAllProgress;
  gatewayReachable: boolean;
  gatewayProbe: StatusScanOverviewResult["gatewaySnapshot"]["gatewayProbe"];
  gatewayCallOverrides: StatusScanOverviewResult["gatewaySnapshot"]["gatewayCallOverrides"];
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  timeoutMs?: number;
}): Promise<{
  configPath: string;
  health: StatusGatewayHealthSafe | undefined;
  diagnosis: {
    snap: ConfigFileSnapshot | null;
    remoteUrlMissing: boolean;
    secretDiagnostics: StatusScanOverviewResult["secretDiagnostics"];
    sentinel: Awaited<ReturnType<typeof readRestartSentinel>> | null;
    lastErr: string | null;
    port: number;
    portUsage: Awaited<ReturnType<typeof inspectPortUsage>> | null;
    tailscaleMode: string;
    tailscale: {
      backendState: null;
      dnsName: string | null;
      ips: string[];
      error: null;
    };
    tailscaleHttpsUrl: string | null;
    skillStatus: ReturnType<typeof buildWorkspaceSkillStatus> | null;
    pluginCompatibility: ReturnType<typeof buildPluginCompatibilityNotices>;
    channelsStatus: StatusScanOverviewResult["channelsStatus"];
    channelIssues: StatusScanOverviewResult["channelIssues"];
    agentStatus: StatusScanOverviewResult["agentStatus"];
    gatewayReachable: boolean;
    health: StatusGatewayHealthSafe | undefined;
    deliveryDiagnostics: unknown;
    nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  };
}> {
  const { overview } = params;
  const snap = await readConfigFileSnapshot({ observe: false }).catch(() => null);
  const configPath = resolveStatusAllConfigPath(snap?.path);

  const health = params.nodeOnlyGateway
    ? undefined
    : await resolveStatusGatewayHealthSafe({
        config: overview.cfg,
        timeoutMs: Math.min(8000, params.timeoutMs ?? 10_000),
        gatewayReachable: params.gatewayReachable,
        gatewayProbeError: params.gatewayProbe?.error ?? null,
        ...(params.gatewayCallOverrides ? { callOverrides: params.gatewayCallOverrides } : {}),
      });
  const diagnostics = params.nodeOnlyGateway
    ? null
    : await resolveStatusGatewayDiagnosticsSafe({
        config: overview.cfg,
        timeoutMs: Math.min(5000, params.timeoutMs ?? 10_000),
        gatewayReachable: params.gatewayReachable,
        ...(params.gatewayCallOverrides ? { callOverrides: params.gatewayCallOverrides } : {}),
      });

  params.progress.setLabel("Checking local state…");
  // These probes are intentionally best-effort so status-all can still print a partial report.
  const sentinel = await readRestartSentinel().catch(() => null);
  const lastErr = await readLastGatewayErrorLine(process.env).catch(() => null);
  const port = resolveGatewayPort(overview.cfg);
  const portUsage = await inspectPortUsage(port).catch(() => null);
  params.progress.tick();

  const defaultWorkspace =
    overview.agentStatus.agents.find((a) => a.id === overview.agentStatus.defaultId)
      ?.workspaceDir ??
    overview.agentStatus.agents[0]?.workspaceDir ??
    null;
  const skillStatus =
    defaultWorkspace != null
      ? (() => {
          try {
            // Skill eligibility depends on whether the default agent may request node exec.
            const nodeSkills = resolveNodeExecEligibility({
              cfg: overview.cfg,
              agentId: overview.agentStatus.defaultId,
            });
            return buildWorkspaceSkillStatus(defaultWorkspace, {
              config: overview.cfg,
              eligibility: {
                nodeSkills,
                remote: getRemoteSkillEligibility({
                  advertiseExecNode: nodeSkills.canExec,
                }),
              },
            });
          } catch {
            return null;
          }
        })()
      : null;
  const pluginCompatibility = buildPluginCompatibilityNotices({ config: overview.cfg });

  return {
    configPath,
    health,
    diagnosis: {
      snap,
      remoteUrlMissing: overview.gatewaySnapshot.remoteUrlMissing,
      secretDiagnostics: overview.secretDiagnostics,
      sentinel,
      lastErr,
      port,
      portUsage,
      tailscaleMode: overview.tailscaleMode,
      tailscale: {
        backendState: null,
        dnsName: overview.tailscaleDns,
        ips: [],
        error: null,
      },
      tailscaleHttpsUrl: overview.tailscaleHttpsUrl,
      skillStatus,
      pluginCompatibility,
      channelsStatus: overview.channelsStatus,
      channelIssues: overview.channelIssues,
      agentStatus: overview.agentStatus,
      gatewayReachable: params.gatewayReachable,
      health,
      deliveryDiagnostics: diagnostics,
      nodeOnlyGateway: params.nodeOnlyGateway,
    },
  };
}

/** Builds the full status-all report data model from a completed overview scan. */
export async function buildStatusAllReportData(params: {
  overview: StatusScanOverviewResult;
  daemon: StatusGatewayServiceSummary;
  nodeService: StatusNodeServiceSummary;
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  progress: StatusAllProgress;
  timeoutMs?: number;
}) {
  const gatewaySnapshot = params.overview.gatewaySnapshot;
  const { configPath, health, diagnosis } = await resolveStatusAllLocalDiagnosis({
    overview: params.overview,
    progress: params.progress,
    gatewayReachable: gatewaySnapshot.gatewayReachable,
    gatewayProbe: gatewaySnapshot.gatewayProbe,
    gatewayCallOverrides: gatewaySnapshot.gatewayCallOverrides,
    nodeOnlyGateway: params.nodeOnlyGateway,
    timeoutMs: params.timeoutMs,
  });

  const overviewSurface: StatusOverviewSurface = buildStatusOverviewSurfaceFromOverview({
    overview: params.overview,
    gatewayService: params.daemon,
    nodeService: params.nodeService,
    nodeOnlyGateway: params.nodeOnlyGateway,
  });
  const overviewRows = buildStatusAllOverviewRows({
    surface: overviewSurface,
    osLabel: params.overview.osSummary.label,
    configPath,
    secretDiagnosticsCount: params.overview.secretDiagnostics.length,
    updateRestartValue: formatUpdateRestartStatusValue(diagnosis.sentinel?.payload),
    agentStatus: params.overview.agentStatus,
    tailscaleBackendState: diagnosis.tailscale.backendState,
  });

  return {
    overviewRows,
    channels: params.overview.channels,
    channelIssues: params.overview.channelIssues.map((issue) => ({
      channel: issue.channel,
      message: issue.message,
    })),
    agentStatus: params.overview.agentStatus,
    connectionDetailsForReport: resolveStatusAllConnectionDetails({
      nodeOnlyGateway: params.nodeOnlyGateway,
      remoteUrlMissing: gatewaySnapshot.remoteUrlMissing,
      gatewayConnection: gatewaySnapshot.gatewayConnection,
      bindMode: params.overview.cfg.gateway?.bind ?? "loopback",
      configPath,
    }),
    diagnosis: {
      ...diagnosis,
      health,
    },
  };
}
