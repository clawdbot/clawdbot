// Shared runtime probes used by status text and JSON commands.
// Heavy modules stay lazily loaded so fast status output avoids security/provider/gateway costs.

import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import { resolveModelAuthLabel } from "../agents/model-auth-label.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../agents/openai-routing.js";
import type { OpenClawConfig } from "../config/types.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import {
  buildCodexSyntheticUsageAuth,
  mergeUsageSummaries,
  shouldUseCodexSyntheticUsageForRuntime,
  resolveUsageCredentialType,
} from "../status/codex-synthetic-usage.js";
import type { HealthSummary } from "./health.js";
import { getDaemonStatusSummary, getNodeDaemonStatusSummary } from "./status.daemon.js";

const providerUsageLoader = createLazyImportLoader(() => import("../infra/provider-usage.js"));
const securityAuditModuleLoader = createLazyImportLoader(
  () => import("../security/audit.runtime.js"),
);
const readOnlyChannelPluginsModuleLoader = createLazyImportLoader(
  () => import("../channels/plugins/read-only.js"),
);
const gatewayCallModuleLoader = createLazyImportLoader(() => import("../gateway/call.js"));

function loadProviderUsage() {
  return providerUsageLoader.load();
}

function loadSecurityAuditModule() {
  return securityAuditModuleLoader.load();
}

function loadReadOnlyChannelPluginsModule() {
  return readOnlyChannelPluginsModuleLoader.load();
}

function loadGatewayCallModule() {
  return gatewayCallModuleLoader.load();
}

function shouldUseConfiguredCodexSyntheticUsage(params: {
  config: OpenClawConfig;
  agentDir: string;
}): boolean {
  const configuredDefault = resolveDefaultModelForAgent({
    cfg: params.config,
    allowPluginNormalization: false,
  });
  const policy = resolveAgentHarnessPolicy({
    config: params.config,
    provider: configuredDefault.provider,
    modelId: configuredDefault.model,
  });
  if (
    !shouldUseCodexSyntheticUsageForRuntime({
      provider: configuredDefault.provider,
      effectiveHarness: policy.runtime,
    })
  ) {
    return false;
  }
  const authLabel = resolveModelAuthLabel({
    provider: configuredDefault.provider,
    acceptedProviderIds: listOpenAIAuthProfileProvidersForAgentRuntime({
      provider: configuredDefault.provider,
      harnessRuntime: policy.runtime,
      config: params.config,
    }),
    cfg: params.config,
    agentDir: params.agentDir,
    includeExternalProfiles: false,
  });
  return resolveUsageCredentialType(authLabel) !== "api_key";
}

/** Runs the lightweight security audit used by status JSON/all output. */
export async function resolveStatusSecurityAudit(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  timeoutMs?: number;
}) {
  const { runSecurityAudit } = await loadSecurityAuditModule();
  const { resolveReadOnlyChannelPluginsForConfig } = await loadReadOnlyChannelPluginsModule();
  const readOnlyPlugins = resolveReadOnlyChannelPluginsForConfig(params.config, {
    activationSourceConfig: params.sourceConfig,
    includeSetupFallbackPlugins: false,
  });
  return await runSecurityAudit({
    config: params.config,
    sourceConfig: params.sourceConfig,
    deep: false,
    ...(params.timeoutMs !== undefined ? { deepTimeoutMs: params.timeoutMs } : {}),
    includeFilesystem: true,
    includeChannelSecurity: true,
    loadPluginSecurityCollectors: false,
    // Missing configured channel plugins make plugin-specific collectors unreliable; omit plugin list then.
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

/** Loads provider usage for status output, defaulting to the config's default agent directory. */
export async function resolveStatusUsageSummary(params: StatusUsageSummaryOptions) {
  const { loadProviderUsageSummary } = await loadProviderUsage();
  const agentDir = params.agentDir ?? resolveDefaultAgentDir(params.config);
  const usage = await loadProviderUsageSummary({
    timeoutMs: params.timeoutMs,
    config: params.config,
    agentDir,
  });
  if (!shouldUseConfiguredCodexSyntheticUsage({ config: params.config, agentDir })) {
    return usage;
  }
  const codexUsage = await loadProviderUsageSummary({
    timeoutMs: params.timeoutMs,
    providers: ["openai"],
    auth: [buildCodexSyntheticUsageAuth()],
    config: params.config,
    agentDir,
  });
  return mergeUsageSummaries(usage, codexUsage);
}

/** Exposes the lazily loaded provider-usage module for callers that need its helpers. */
export async function loadStatusProviderUsageModule() {
  return await loadProviderUsage();
}

/** Calls gateway health and lets errors propagate to deep status callers. */
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

/** Calls gateway health but converts unreachable/failing probes into an error object. */
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
    // Preserve the probe error so status-all can explain why health was not called.
    return { error: params.gatewayProbeError ?? "gateway unreachable" };
  }
  const { callGateway } = await loadGatewayCallModule();
  return await callGateway<HealthSummary>({
    method: "health",
    params: { probe: true },
    timeoutMs: params.timeoutMs,
    config: params.config,
    ...params.callOverrides,
  }).catch((err: unknown) => ({ error: String(err) }));
}

/** Reads gateway delivery diagnostics when reachable, returning null on failures. */
export async function resolveStatusGatewayDiagnosticsSafe(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
  gatewayReachable: boolean;
  callOverrides?: {
    url: string;
    token?: string;
    password?: string;
  };
}) {
  if (!params.gatewayReachable) {
    return null;
  }
  const { callGateway } = await loadGatewayCallModule();
  return await callGateway<unknown>({
    method: "diagnostics.stability",
    params: { limit: 1000 },
    timeoutMs: params.timeoutMs,
    config: params.config,
    ...params.callOverrides,
  }).catch(() => null);
}

/** Reads the most recent gateway heartbeat only when the gateway probe succeeded. */
async function resolveStatusLastHeartbeat(params: {
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

// Default bound for service-manager probes when status runs without an explicit
// --timeout, so a wedged systemd/launchd socket cannot hang `openclaw status`.
const DEFAULT_SERVICE_PROBE_TIMEOUT_MS = 5000;

/** Resolves launchd/systemd summaries for the gateway and node services together. */
export async function resolveStatusServiceSummaries(timeoutMs?: number) {
  const probeTimeoutMs = timeoutMs ?? DEFAULT_SERVICE_PROBE_TIMEOUT_MS;
  return await Promise.all([
    getDaemonStatusSummary(probeTimeoutMs),
    getNodeDaemonStatusSummary(probeTimeoutMs),
  ]);
}

type StatusUsageSummary = Awaited<ReturnType<typeof resolveStatusUsageSummary>>;
type StatusGatewayHealth = Awaited<ReturnType<typeof resolveStatusGatewayHealth>>;
type StatusLastHeartbeat = Awaited<ReturnType<typeof resolveStatusLastHeartbeat>>;
type StatusGatewayServiceSummary = Awaited<ReturnType<typeof getDaemonStatusSummary>>;
type StatusNodeServiceSummary = Awaited<ReturnType<typeof getNodeDaemonStatusSummary>>;
type StatusSecurityAudit = Awaited<ReturnType<typeof resolveStatusSecurityAudit>>;

/** Resolves optional usage/deep runtime details plus service summaries for status output. */
async function resolveStatusRuntimeDetails(params: {
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
  // Last heartbeat is a deep-only gateway call; fast status should not spend network time here.
  const lastHeartbeat = params.deep
    ? await resolveStatusLastHeartbeat({
        config: params.config,
        timeoutMs: params.timeoutMs,
        gatewayReachable: params.gatewayReachable,
      })
    : null;
  const [gatewayService, nodeService] = await resolveStatusServiceSummaries(params.timeoutMs);
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

/** Resolves the full runtime snapshot, including optional security audit, for status JSON/text. */
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
    timeoutMs?: number;
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
        timeoutMs: params.timeoutMs,
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
