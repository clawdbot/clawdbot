import type { OpenClawConfig } from "../config/types.js";
import type { collectChannelStatusIssues as collectChannelStatusIssuesFn } from "../infra/channels-status-issues.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import { hasConfiguredChannelsForReadOnlyScope } from "../plugins/channel-plugin-ids.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { buildChannelsTable as buildChannelsTableFn } from "./status-all/channels.js";
import type { getAgentLocalStatuses as getAgentLocalStatusesFn } from "./status.agent-local.js";
import {
  buildColdStartStatusSummary,
  createStatusScanCoreBootstrap,
} from "./status.scan.bootstrap-shared.js";
import { loadStatusScanCommandConfig } from "./status.scan.config-shared.js";
import type { GatewayProbeSnapshot } from "./status.scan.shared.js";

const statusScanDepsRuntimeModuleLoader = createLazyImportLoader(
  () => import("./status.scan.deps.runtime.js"),
);
const statusAgentLocalModuleLoader = createLazyImportLoader(
  () => import("./status.agent-local.js"),
);
const statusUpdateModuleLoader = createLazyImportLoader(() => import("./status.update.js"));
const statusScanRuntimeModuleLoader = createLazyImportLoader(
  () => import("./status.scan.runtime.js"),
);
const gatewayCallModuleLoader = createLazyImportLoader(() => import("../gateway/call.js"));
const statusSummaryModuleLoader = createLazyImportLoader(() => import("./status.summary.js"));
const configModuleLoader = createLazyImportLoader(() => import("../config/config.js"));
const commandConfigResolutionModuleLoader = createLazyImportLoader(
  () => import("../cli/command-config-resolution.js"),
);
const commandSecretTargetsModuleLoader = createLazyImportLoader(
  () => import("../cli/command-secret-targets.js"),
);

function loadStatusScanDepsRuntimeModule() {
  return statusScanDepsRuntimeModuleLoader.load();
}

function loadStatusAgentLocalModule() {
  return statusAgentLocalModuleLoader.load();
}

function loadStatusUpdateModule() {
  return statusUpdateModuleLoader.load();
}

function loadStatusScanRuntimeModule() {
  return statusScanRuntimeModuleLoader.load();
}

function loadGatewayCallModule() {
  return gatewayCallModuleLoader.load();
}

function loadStatusSummaryModule() {
  return statusSummaryModuleLoader.load();
}

function loadConfigModule() {
  return configModuleLoader.load();
}

function loadCommandConfigResolutionModule() {
  return commandConfigResolutionModuleLoader.load();
}

function loadCommandSecretTargetsModule() {
  return commandSecretTargetsModuleLoader.load();
}

async function resolveStatusChannelsStatus(params: {
  cfg: OpenClawConfig;
  gatewayReachable: boolean;
  opts: { timeoutMs?: number; all?: boolean };
  gatewayCallOverrides?: GatewayProbeSnapshot["gatewayCallOverrides"];
  useGatewayCallOverrides?: boolean;
}) {
  if (!params.gatewayReachable) {
    return null;
  }
  const { callGateway } = await loadGatewayCallModule();
  return await callGateway({
    config: params.cfg,
    method: "channels.status",
    params: {
      probe: false,
      timeoutMs: Math.min(8000, params.opts.timeoutMs ?? 10_000),
    },
    timeoutMs: Math.min(params.opts.all ? 5000 : 2500, params.opts.timeoutMs ?? 10_000),
    ...(params.useGatewayCallOverrides === true ? (params.gatewayCallOverrides ?? {}) : {}),
  }).catch(() => null);
}

export type StatusScanOverviewResult = {
  coldStart: boolean;
  hasConfiguredChannels: boolean;
  skipColdStartNetworkChecks: boolean;
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  secretDiagnostics: string[];
  osSummary: ReturnType<typeof resolveOsSummary>;
  tailscaleMode: string;
  tailscaleDns: string | null;
  tailscaleHttpsUrl: string | null;
  update: UpdateCheckResult;
  gatewaySnapshot: Pick<
    GatewayProbeSnapshot,
    | "gatewayConnection"
    | "remoteUrlMissing"
    | "gatewayMode"
    | "gatewayProbeAuth"
    | "gatewayProbeAuthWarning"
    | "gatewayProbe"
    | "gatewayReachable"
    | "gatewaySelf"
    | "gatewayCallOverrides"
  >;
  channelsStatus: unknown;
  channelIssues: ReturnType<typeof collectChannelStatusIssuesFn>;
  channels: Awaited<ReturnType<typeof buildChannelsTableFn>>;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;
};

export async function collectStatusScanOverview(params: {
  commandName: string;
  opts: { timeoutMs?: number; all?: boolean };
  showSecrets: boolean;
  runtime?: RuntimeEnv;
  allowMissingConfigFastPath?: boolean;
  resolveHasConfiguredChannels?: (cfg: OpenClawConfig, sourceConfig: OpenClawConfig) => boolean;
  includeChannelsData?: boolean;
  includeLiveChannelStatus?: boolean;
  includeChannelSetupRuntimeFallback?: boolean;
  useGatewayCallOverridesForChannelsStatus?: boolean;
  progress?: {
    setLabel(label: string): void;
    tick(): void;
  };
  labels?: {
    loadingConfig?: string;
    checkingTailscale?: string;
    checkingForUpdates?: string;
    resolvingAgents?: string;
    probingGateway?: string;
    queryingChannelStatus?: string;
    summarizingChannels?: string;
  };
}): Promise<StatusScanOverviewResult> {
  if (params.labels?.loadingConfig) {
    params.progress?.setLabel(params.labels.loadingConfig);
  }
  const {
    coldStart,
    sourceConfig,
    resolvedConfig: cfg,
    secretDiagnostics,
  } = await loadStatusScanCommandConfig({
    commandName: params.commandName,
    allowMissingConfigFastPath: params.allowMissingConfigFastPath,
    readBestEffortConfig: async () => (await loadConfigModule()).readBestEffortConfig(),
    resolveConfig: async (loadedConfig) =>
      await (
        await loadCommandConfigResolutionModule()
      ).resolveCommandConfigWithSecrets({
        config: loadedConfig,
        commandName: params.commandName,
        targetIds: (await loadCommandSecretTargetsModule()).getStatusCommandSecretTargetIds(
          loadedConfig,
        ),
        mode: "read_only_status",
        ...(params.runtime ? { runtime: params.runtime } : {}),
      }),
  });
  params.progress?.tick();
  const hasConfiguredChannels = params.resolveHasConfiguredChannels
    ? params.resolveHasConfiguredChannels(cfg, sourceConfig)
    : hasConfiguredChannelsForReadOnlyScope({ config: cfg, activationSourceConfig: sourceConfig });
  const osSummary = resolveOsSummary();
  const bootstrap = await createStatusScanCoreBootstrap<
    Awaited<ReturnType<typeof getAgentLocalStatusesFn>>
  >({
    coldStart,
    cfg,
    hasConfiguredChannels,
    opts: params.opts,
    getTailnetHostname: async (runner) =>
      await loadStatusScanDepsRuntimeModule().then(({ getTailnetHostname }) =>
        getTailnetHostname(runner),
      ),
    getUpdateCheckResult: async (updateParams) =>
      await loadStatusUpdateModule().then(({ getUpdateCheckResult }) =>
        getUpdateCheckResult(updateParams),
      ),
    getAgentLocalStatuses: async (bootstrapCfg) =>
      await loadStatusAgentLocalModule().then(({ getAgentLocalStatuses }) =>
        getAgentLocalStatuses(bootstrapCfg),
      ),
  });

  if (params.labels?.checkingTailscale) {
    params.progress?.setLabel(params.labels.checkingTailscale);
  }
  const tailscaleDns = await bootstrap.tailscaleDnsPromise;
  params.progress?.tick();

  if (params.labels?.checkingForUpdates) {
    params.progress?.setLabel(params.labels.checkingForUpdates);
  }
  const update = await bootstrap.updatePromise;
  params.progress?.tick();

  if (params.labels?.resolvingAgents) {
    params.progress?.setLabel(params.labels.resolvingAgents);
  }
  const agentStatus = await bootstrap.agentStatusPromise;
  params.progress?.tick();

  if (params.labels?.probingGateway) {
    params.progress?.setLabel(params.labels.probingGateway);
  }
  const gatewaySnapshot = await bootstrap.gatewayProbePromise;
  params.progress?.tick();

  const tailscaleHttpsUrl = await bootstrap.resolveTailscaleHttpsUrl();
  const includeChannelsData = params.includeChannelsData !== false;
  const includeLiveChannelStatus = params.includeLiveChannelStatus !== false;
  const { channelsStatus, channelIssues, channels } = includeChannelsData
    ? await (async () => {
        if (params.labels?.queryingChannelStatus) {
          params.progress?.setLabel(params.labels.queryingChannelStatus);
        }
        const channelsStatus = includeLiveChannelStatus
          ? await resolveStatusChannelsStatus({
              cfg,
              gatewayReachable: gatewaySnapshot.gatewayReachable,
              opts: params.opts,
              gatewayCallOverrides: gatewaySnapshot.gatewayCallOverrides,
              useGatewayCallOverrides: params.useGatewayCallOverridesForChannelsStatus,
            })
          : null;
        params.progress?.tick();
        const { collectChannelStatusIssues, buildChannelsTable } =
          await loadStatusScanRuntimeModule().then(({ statusScanRuntime }) => statusScanRuntime);
        const channelIssues = channelsStatus ? collectChannelStatusIssues(channelsStatus) : [];
        if (params.labels?.summarizingChannels) {
          params.progress?.setLabel(params.labels.summarizingChannels);
        }
        const channels = await buildChannelsTable(cfg, {
          showSecrets: params.showSecrets,
          sourceConfig,
          includeSetupFallbackPlugins: params.includeChannelSetupRuntimeFallback !== false,
          liveChannelStatus: channelsStatus,
        });
        params.progress?.tick();
        return { channelsStatus, channelIssues, channels };
      })()
    : {
        channelsStatus: null,
        channelIssues: [],
        channels: { rows: [], details: [] },
      };

  return {
    coldStart,
    hasConfiguredChannels,
    skipColdStartNetworkChecks: bootstrap.skipColdStartNetworkChecks,
    cfg,
    sourceConfig,
    secretDiagnostics,
    osSummary,
    tailscaleMode: bootstrap.tailscaleMode,
    tailscaleDns,
    tailscaleHttpsUrl,
    update,
    gatewaySnapshot,
    channelsStatus,
    channelIssues,
    channels,
    agentStatus,
  };
}

export async function resolveStatusSummaryFromOverview(params: {
  overview: Pick<StatusScanOverviewResult, "skipColdStartNetworkChecks" | "cfg" | "sourceConfig">;
  includeChannelSummary?: boolean;
}) {
  if (params.overview.skipColdStartNetworkChecks) {
    return buildColdStartStatusSummary();
  }
  return await loadStatusSummaryModule().then(({ getStatusSummary }) =>
    getStatusSummary({
      config: params.overview.cfg,
      sourceConfig: params.overview.sourceConfig,
      includeChannelSummary: params.includeChannelSummary,
    }),
  );
}
