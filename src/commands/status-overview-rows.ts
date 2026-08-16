// Builds overview table rows for `openclaw status` and `openclaw status --all`.
// The row builders combine scan surfaces with health/session summaries while keeping rendering elsewhere.

import { formatCliCommand } from "../cli/command-format.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { StatusSummary } from "../status/types.js";
import { VERSION } from "../version.js";
import { buildBackupStatusValue, readBackupFreshness } from "./backup-health.js";
import type { HealthSummary } from "./health.js";
import {
  buildStatusOverviewRowsFromSurface,
  type StatusOverviewSurface,
} from "./status-overview-surface.ts";
import {
  buildStatusAllAgentsValue,
  buildStatusEventsValue,
  buildStatusPluginCompatibilityValue,
  buildStatusProbesValue,
  buildStatusSecretsValue,
  buildStatusSessionsOverviewValue,
} from "./status-overview-values.ts";
import type { AgentLocalStatus } from "./status.agent-local.js";
import {
  buildStatusAgentsValue,
  buildStatusHeartbeatValue,
  buildStatusLastHeartbeatValue,
  buildStatusMemoryValue,
  buildStatusTasksValue,
  type StatusMemoryStateResolvers,
} from "./status.command-sections.js";
import type { MemoryPluginStatus, MemoryStatusSnapshot } from "./status.scan.shared.js";

/** Builds the default `openclaw status` overview rows from scan, health, memory, and session inputs. */
export function buildStatusCommandOverviewRows(
  params: {
    env: NodeJS.ProcessEnv;
    opts: {
      deep?: boolean;
    };
    surface: StatusOverviewSurface;
    osLabel: string;
    summary: StatusSummary;
    health?: HealthSummary;
    lastHeartbeat: HeartbeatEventPayload | null;
    agentStatus: {
      defaultId?: string | null;
      bootstrapPendingCount: number;
      totalSessions: number;
      agents: AgentLocalStatus[];
    };
    memory: MemoryStatusSnapshot | null;
    memoryPlugin: MemoryPluginStatus;
    pluginCompatibility: PluginCompatibilityNotice[];
    ok: (value: string) => string;
    warn: (value: string) => string;
    muted: (value: string) => string;
    formatTimeAgo: (ageMs: number) => string;
    formatKTokens: (value: number) => string;
    updateValue?: string;
    updateRestartValue?: string | null;
  } & StatusMemoryStateResolvers,
) {
  const agentsValue = buildStatusAgentsValue({
    agentStatus: params.agentStatus,
    formatTimeAgo: params.formatTimeAgo,
  });
  const eventsValue = buildStatusEventsValue({
    queuedSystemEvents: params.summary.queuedSystemEvents,
  });
  const degradedSecretOwners = params.summary.degradedSecretOwners ?? [];
  const degradedSecretsValue =
    degradedSecretOwners.length > 0
      ? params.warn(
          `${degradedSecretOwners.length} degraded · ${degradedSecretOwners
            .map((owner) => `${owner.ownerKind}:${owner.ownerId}`)
            .join(", ")}`,
        )
      : null;
  const degradedPlugins = params.summary.degradedPlugins ?? [];
  const degradedPluginsValue =
    degradedPlugins.length > 0
      ? params.warn(
          `${degradedPlugins.length} configured-unavailable · ${degradedPlugins
            .map((plugin) => plugin.pluginId)
            .join(", ")}`,
        )
      : null;
  const tasksValue = buildStatusTasksValue({
    summary: params.summary,
    warn: params.warn,
    muted: params.muted,
  });
  const probesValue = buildStatusProbesValue({
    health: params.health,
    ok: params.ok,
    muted: params.muted,
  });
  const heartbeatValue = buildStatusHeartbeatValue({ summary: params.summary });
  const lastHeartbeatValue = buildStatusLastHeartbeatValue({
    deep: params.opts.deep,
    gatewayReachable: params.surface.gatewayReachable,
    lastHeartbeat: params.lastHeartbeat,
    warn: params.warn,
    muted: params.muted,
    formatTimeAgo: params.formatTimeAgo,
  });
  const memoryValue = buildStatusMemoryValue({
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    ok: params.ok,
    warn: params.warn,
    muted: params.muted,
    resolveMemoryVectorState: params.resolveMemoryVectorState,
    resolveMemoryFtsState: params.resolveMemoryFtsState,
    resolveMemoryCacheSummary: params.resolveMemoryCacheSummary,
    memoryUnavailableLabel: "not checked",
  });
  const pluginCompatibilityValue = buildStatusPluginCompatibilityValue({
    notices: params.pluginCompatibility,
    ok: params.ok,
    warn: params.warn,
  });
  const hostDesktop = params.summary.hostDesktop ?? {
    enabled: false,
    state: "disabled" as const,
    port: 5900,
  };
  const hostDesktopValue =
    hostDesktop.state === "disabled"
      ? params.muted("disabled")
      : hostDesktop.state === "managed"
        ? hostDesktop.managedState === "running"
          ? `managed · running · display :${hostDesktop.display} · 127.0.0.1:${hostDesktop.port} · security VncAuth`
          : hostDesktop.managedState === "failed"
            ? `managed · failed: ${hostDesktop.error}`
            : hostDesktop.managedState === "unknown"
              ? "managed · runtime state unavailable"
              : `managed · ${hostDesktop.managedState === "not-started" ? "not started" : "starting"}`
        : `${hostDesktop.state} · 127.0.0.1:${hostDesktop.port}${hostDesktop.security ? ` · security ${hostDesktop.security}` : ""}`;
  return buildStatusOverviewRowsFromSurface({
    surface: params.surface,
    decorateOk: params.ok,
    decorateWarn: params.warn,
    decorateTailscaleOff: params.muted,
    decorateTailscaleWarn: params.warn,
    prefixRows: [{ Item: "OS", Value: `${params.osLabel} · node ${process.versions.node}` }],
    updateValue: params.updateValue,
    agentsValue,
    suffixRows: [
      ...(params.updateRestartValue
        ? [{ Item: "Update restart", Value: params.updateRestartValue }]
        : []),
      { Item: "Memory", Value: memoryValue },
      { Item: "Host desktop", Value: hostDesktopValue },
      ...(degradedSecretsValue ? [{ Item: "Degraded secrets", Value: degradedSecretsValue }] : []),
      ...(degradedPluginsValue ? [{ Item: "Degraded plugins", Value: degradedPluginsValue }] : []),
      { Item: "Plugin compatibility", Value: pluginCompatibilityValue },
      { Item: "Probes", Value: probesValue },
      { Item: "Events", Value: eventsValue },
      { Item: "Tasks", Value: tasksValue },
      {
        Item: "Backups",
        Value: buildBackupStatusValue({
          freshness: readBackupFreshness(params.env),
          formatTimeAgo: params.formatTimeAgo,
        }),
      },
      { Item: "Heartbeat", Value: heartbeatValue },
      ...(lastHeartbeatValue ? [{ Item: "Last heartbeat", Value: lastHeartbeatValue }] : []),
      {
        Item: "Sessions",
        Value: buildStatusSessionsOverviewValue({
          sessions: params.summary.sessions,
          formatKTokens: params.formatKTokens,
        }),
      },
    ],
    gatewayAuthWarningValue: params.surface.gatewayProbeAuthWarning
      ? params.warn(params.surface.gatewayProbeAuthWarning)
      : null,
  });
}

/** Builds the expanded status-all overview rows, including config and security hints. */
export function buildStatusAllOverviewRows(params: {
  surface: StatusOverviewSurface;
  osLabel: string;
  configPath: string;
  secretDiagnosticsCount: number;
  updateRestartValue?: string | null;
  agentStatus: {
    bootstrapPendingCount: number;
    totalSessions: number;
    agents: Array<{
      id: string;
      lastActiveAgeMs?: number | null;
    }>;
  };
  tailscaleBackendState?: string | null;
}) {
  return buildStatusOverviewRowsFromSurface({
    surface: params.surface,
    tailscaleBackendState: params.tailscaleBackendState,
    includeBackendStateWhenOff: true,
    includeBackendStateWhenOn: true,
    includeDnsNameWhenOff: true,
    prefixRows: [
      { Item: "Version", Value: VERSION },
      { Item: "OS", Value: params.osLabel },
      { Item: "Node", Value: process.versions.node },
      { Item: "Config", Value: params.configPath },
    ],
    middleRows: [
      ...(params.updateRestartValue
        ? [{ Item: "Update restart", Value: params.updateRestartValue }]
        : []),
      { Item: "Security", Value: `Run: ${formatCliCommand("openclaw security audit --deep")}` },
    ],
    agentsValue: buildStatusAllAgentsValue({
      agentStatus: params.agentStatus,
    }),
    suffixRows: [
      {
        Item: "Secrets",
        Value: buildStatusSecretsValue(params.secretDiagnosticsCount),
      },
    ],
    gatewaySelfFallbackValue: "unknown",
  });
}
