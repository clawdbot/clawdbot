import type { OpenClawConfig } from "../config/types.js";
import type { collectChannelStatusIssues as collectChannelStatusIssuesFn } from "../infra/channels-status-issues.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import { hasConfiguredChannelsForReadOnlyScope } from "../plugins/channel-plugin-ids.js";
import type { RuntimeEnv } from "../runtime.js";
import type { buildChannelsTable as buildChannelsTableFn } from "./status-all/channels.js";
import type { getAgentLocalStatuses as getAgentLocalStatusesFn } from "./status.agent-local.js";
import {
  buildColdStartStatusSummary,
  createStatusScanCoreBootstrap,
} from "./status.scan.bootstrap-shared.js";
import { loadStatusScanCommandConfig } from "./status.scan.config-shared.js";
import type { GatewayProbeSnapshot } from "./status.scan.shared.js";

let statusScanDepsRuntimeModulePromise:
  | Promise<typeof import("./status.scan.deps.runtime.js")>
  | undefined;
let statusAgentLocalModulePromise: Promise<typeof import("./status.agent-local.js")> | undefined;
let statusUpdateModulePromise: Promise<typeof import("./status.update.js")> | undefined;
let statusScanRuntimeModulePromise: Promise<typeof import("./status.scan.runtime.js")> | undefined;
let gatewayCallModulePromise: Promise<typeof import("../gateway/call.js")> | undefined;
let statusSummaryModulePromise: Promise<typeof import("./status.summary.js")> | undefined;
let configModulePromise: Promise<typeof import("../config/config.js")> | undefined;
let commandConfigResolutionModulePromise:
  | Promise<typeof import("../cli/command-config-resolution.js")>
  | undefined;
let commandSecretTargetsModulePromise:
  | Promise<typeof import("../cli/command-secret-targets.js")>
  | undefined;

function loadStatusScanDepsRuntimeModule() {
  statusScanDepsRuntimeModulePromise ??= import("./status.scan.deps.runtime.js");
  return statusScanDepsRuntimeModulePromise;
}

function loadStatusAgentLocalModule() {
  statusAgentLocalModulePromise ??= import("./status.agent-local.js");
  return statusAgentLocalModulePromise;
}

function loadStatusUpdateModule() {
  statusUpdateModulePromise ??= import("./status.update.js");
  return statusUpdateModulePromise;
}

function loadStatusScanRuntimeModule() {
  statusScanRuntimeModulePromise ??= import("./status.scan.runtime.js");
  return statusScanRuntimeModulePromise;
}

function loadGatewayCallModule() {
  gatewayCallModulePromise ??= import("../gateway/call.js");
  return gatewayCallModulePromise;
}

function loadStatusSummaryModule() {
  statusSummaryModulePromise ??= import("./status.summary.js");
  return statusSummaryModulePromise;
}

function loadConfigModule() {
  configModulePromise ??= import("../config/config.js");
  return configModulePromise;
}

function loadCommandConfigResolutionModule() {
  commandConfigResolutionModulePromise ??= import("../cli/command-config-resolution.js");
  return commandConfigResolutionModulePromise;
}

function loadCommandSecretTargetsModule() {
  commandSecretTargetsModulePromise ??= import("../cli/command-secret-targets.js");
  return commandSecretTargetsModulePromise;
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
          includeSetupRuntimeFallback: params.includeChannelSetupRuntimeFallback !== false,
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
