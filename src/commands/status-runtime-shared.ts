import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { OpenClawConfig } from "../config/types.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { HealthSummary } from "./health.js";
import { getDaemonStatusSummary, getNodeDaemonStatusSummary } from "./status.daemon.js";

const providerUsageLoader = createLazyImportLoader(() => import("../infra/provider-usage.js"));
const securityAuditModuleLoader = createLazyImportLoader(
  () => import("../security/audit.runtime.js"),
);
const gatewayCallModuleLoader = createLazyImportLoader(() => import("../gateway/call.js"));

function loadProviderUsage() {
  return providerUsageLoader.load();
}

function loadSecurityAuditModule() {
  return securityAuditModuleLoader.load();
}

function loadGatewayCallModule() {
  return gatewayCallModuleLoader.load();
}

export async function resolveStatusSecurityAudit(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
}) {
  const { runSecurityAudit } = await loadSecurityAuditModule();
  const readOnlyPlugins = resolveReadOnlyChannelPluginsForConfig(params.config, {
    activationSourceConfig: params.sourceConfig,
    includeSetupFallbackPlugins: false,
  });
  return await runSecurityAudit({
    config: params.config,
    sourceConfig: params.sourceConfig,
    deep: false,
    includeFilesystem: true,
    includeChannelSecurity: true,
    loadPluginSecurityCollectors: false,
    ...(readOnlyPlugins.missingConfiguredChannelIds.length === 0
      ? { plugins: readOnlyPlugins.plugins }
      : {}),
  });
}

type StatusUsageSummaryOptions = {
  config: OpenClawConfig;
  timeoutMs?: number;
  agentDir?: string;
};

export async function resolveStatusUsageSummary(params: StatusUsageSummaryOptions) {
  const { loadProviderUsageSummary } = await loadProviderUsage();
  return await loadProviderUsageSummary({
    timeoutMs: params.timeoutMs,
    config: params.config,
    agentDir: params.agentDir ?? resolveDefaultAgentDir(params.config),
  });
}

export async function loadStatusProviderUsageModule() {
  return await loadProviderUsage();
}

export async function resolveStatusGatewayHealth(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
}) {
  const { callGateway } = await loadGatewayCallModule();
  return await callGateway<HealthSummary>({
    method: "health",
    params: { probe: true },
    timeoutMs: params.timeoutMs,
    config: params.config,
  });
}

export async function resolveStatusGatewayHealthSafe(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
  gatewayReachable: boolean;
  gatewayProbeError?: string | null;
  callOverrides?: {
    url: string;
    token?: string;
    password?: string;
  };
}) {
  if (!params.gatewayReachable) {
    return { error: params.gatewayProbeError ?? "gateway unreachable" };
  }
  const { callGateway } = await loadGatewayCallModule();
  return await callGateway<HealthSummary>({
    method: "health",
    params: { probe: true },
    timeoutMs: params.timeoutMs,
    config: params.config,
    ...params.callOverrides,
  }).catch((err) => ({ error: String(err) }));
}

export async function resolveStatusLastHeartbeat(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
  gatewayReachable: boolean;
}) {
  if (!params.gatewayReachable) {
    return null;
  }
  const { callGateway } = await loadGatewayCallModule();
  return await callGateway<HeartbeatEventPayload | null>({
    method: "last-heartbeat",
    params: {},
    timeoutMs: params.timeoutMs,
    config: params.config,
  }).catch(() => null);
}

export async function resolveStatusServiceSummaries() {
  return await Promise.all([getDaemonStatusSummary(), getNodeDaemonStatusSummary()]);
}

type StatusUsageSummary = Awaited<ReturnType<typeof resolveStatusUsageSummary>>;
type StatusGatewayHealth = Awaited<ReturnType<typeof resolveStatusGatewayHealth>>;
type StatusLastHeartbeat = Awaited<ReturnType<typeof resolveStatusLastHeartbeat>>;
type StatusGatewayServiceSummary = Awaited<ReturnType<typeof getDaemonStatusSummary>>;
type StatusNodeServiceSummary = Awaited<ReturnType<typeof getNodeDaemonStatusSummary>>;
type StatusSecurityAudit = Awaited<ReturnType<typeof resolveStatusSecurityAudit>>;

export async function resolveStatusRuntimeDetails(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
  usage?: boolean;
  deep?: boolean;
  gatewayReachable: boolean;
  suppressHealthErrors?: boolean;
  resolveUsage?: (input: StatusUsageSummaryOptions) => Promise<StatusUsageSummary>;
  resolveHealth?: (input: {
    config: OpenClawConfig;
    timeoutMs?: number;
  }) => Promise<StatusGatewayHealth>;
}) {
  const resolveUsageSummary = params.resolveUsage ?? resolveStatusUsageSummary;
  const resolveGatewayHealthSummary = params.resolveHealth ?? resolveStatusGatewayHealth;
  const usage = params.usage
    ? await resolveUsageSummary({
        timeoutMs: params.timeoutMs,
        config: params.config,
      })
    : undefined;
  const health = params.deep
    ? params.suppressHealthErrors
      ? await resolveGatewayHealthSummary({
          config: params.config,
          timeoutMs: params.timeoutMs,
        }).catch(() => undefined)
      : await resolveGatewayHealthSummary({
          config: params.config,
          timeoutMs: params.timeoutMs,
        })
    : undefined;
  const lastHeartbeat = params.deep
    ? await resolveStatusLastHeartbeat({
        config: params.config,
        timeoutMs: params.timeoutMs,
        gatewayReachable: params.gatewayReachable,
      })
    : null;
  const [gatewayService, nodeService] = await resolveStatusServiceSummaries();
  const result = {
    usage,
    health,
    lastHeartbeat,
    gatewayService,
    nodeService,
  };
  return result satisfies {
    usage?: StatusUsageSummary;
    health?: StatusGatewayHealth;
    lastHeartbeat: StatusLastHeartbeat;
    gatewayService: StatusGatewayServiceSummary;
    nodeService: StatusNodeServiceSummary;
  };
}

export async function resolveStatusRuntimeSnapshot(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  timeoutMs?: number;
  usage?: boolean;
  deep?: boolean;
  gatewayReachable: boolean;
  includeSecurityAudit?: boolean;
  suppressHealthErrors?: boolean;
  resolveSecurityAudit?: (input: {
    config: OpenClawConfig;
    sourceConfig: OpenClawConfig;
  }) => Promise<StatusSecurityAudit>;
  resolveUsage?: (input: StatusUsageSummaryOptions) => Promise<StatusUsageSummary>;
  resolveHealth?: (input: {
    config: OpenClawConfig;
    timeoutMs?: number;
  }) => Promise<StatusGatewayHealth>;
}) {
  const securityAudit = params.includeSecurityAudit
    ? await (params.resolveSecurityAudit ?? resolveStatusSecurityAudit)({
        config: params.config,
        sourceConfig: params.sourceConfig,
      })
    : undefined;
  const runtimeDetails = await resolveStatusRuntimeDetails({
    config: params.config,
    timeoutMs: params.timeoutMs,
    usage: params.usage,
    deep: params.deep,
    gatewayReachable: params.gatewayReachable,
    suppressHealthErrors: params.suppressHealthErrors,
    resolveUsage: params.resolveUsage,
    resolveHealth: params.resolveHealth,
  });
  return {
    securityAudit,
    ...runtimeDetails,
  } satisfies {
    securityAudit?: StatusSecurityAudit;
    usage?: StatusUsageSummary;
    health?: StatusGatewayHealth;
    lastHeartbeat: StatusLastHeartbeat;
    gatewayService: StatusGatewayServiceSummary;
    nodeService: StatusNodeServiceSummary;
  };
}
