import { formatCliCommand } from "../cli/command-format.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import { VERSION } from "../version.js";
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
import type { StatusSummary } from "./status.types.js";

function readModelPricingHealth(params: {
  health?: HealthSummary;
  surface: StatusOverviewSurface;
}): HealthSummary["modelPricing"] | undefined {
  if (params.health?.modelPricing) {
    return params.health.modelPricing;
  }
  const probeHealth = params.surface.gatewayProbe?.health;
  if (!probeHealth || typeof probeHealth !== "object") {
    return undefined;
  }
  const modelPricing = (probeHealth as { modelPricing?: unknown }).modelPricing;
  if (!modelPricing || typeof modelPricing !== "object") {
    return undefined;
  }
  const state = (modelPricing as { state?: unknown }).state;
  if (state !== "ok" && state !== "degraded" && state !== "disabled") {
    return undefined;
  }
  return modelPricing as HealthSummary["modelPricing"];
}

function buildModelPricingOverviewValue(params: {
  health?: HealthSummary["modelPricing"];
  ok: (value: string) => string;
  warn: (value: string) => string;
  muted: (value: string) => string;
}): string | null {
  const health = params.health;
  if (!health) {
    return null;
  }
  if (health.state !== "degraded") {
    return null;
  }
  const detail = health.detail ? ` · ${health.detail}` : "";
  return params.warn(`warning · optional pricing refresh degraded${detail}`);
}

export function buildStatusCommandOverviewRows(
  params: {
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
  } & StatusMemoryStateResolvers,
) {
  const agentsValue = buildStatusAgentsValue({
    agentStatus: params.agentStatus,
    formatTimeAgo: params.formatTimeAgo,
  });
  const eventsValue = buildStatusEventsValue({
    queuedSystemEvents: params.summary.queuedSystemEvents,
  });
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
  const modelPricingValue = buildModelPricingOverviewValue({
    health: readModelPricingHealth({
      health: params.health,
      surface: params.surface,
    }),
    ok: params.ok,
    warn: params.warn,
    muted: params.muted,
  });

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
      ...(modelPricingValue ? [{ Item: "Model pricing", Value: modelPricingValue }] : []),
      { Item: "Memory", Value: memoryValue },
      { Item: "Plugin compatibility", Value: pluginCompatibilityValue },
      { Item: "Probes", Value: probesValue },
      { Item: "Events", Value: eventsValue },
      { Item: "Tasks", Value: tasksValue },
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

export function buildStatusAllOverviewRows(params: {
  surface: StatusOverviewSurface;
  osLabel: string;
  configPath: string;
  secretDiagnosticsCount: number;
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
