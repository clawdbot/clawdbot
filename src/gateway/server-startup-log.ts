// Gateway startup logging helpers.
// Produces the compact ready banner with resolved model and safety state.
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import chalk from "chalk";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveDefaultAgentId, resolveAgentConfig } from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { formatFastModeValue, resolveFastModeState } from "../agents/fast-mode.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { legacyModelKey, modelKey } from "../agents/model-selection-normalize.js";
import {
  buildConfiguredModelCatalog,
  resolveConfiguredModelRef,
} from "../agents/model-selection-shared.js";
import { resolveThinkingDefault } from "../agents/model-thinking-default.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getResolvedLoggerSettings } from "../logging.js";
import { collectEnabledInsecureOrDangerousFlagsFromCurrentSnapshot } from "../security/dangerous-config-flags-current.js";

type StartupThinkLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max"
  | "ultra";

/** Emit startup summary lines after Gateway bind and plugin loading complete. */
export async function logGatewayStartup(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  bindHost: string;
  bindHosts?: string[];
  port: number;
  loadedPluginIds: readonly string[];
  startupStartedAt?: number;
  tlsEnabled?: boolean;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string) => void };
  isNixMode: boolean;
}) {
  const { provider: agentProvider, model: agentModel } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const modelRef = `${agentProvider}/${agentModel}`;
  const modelDetails = formatAgentModelStartupDetails({
    cfg: params.cfg,
    provider: agentProvider,
    model: agentModel,
  });
  params.log.info(`agent model: ${modelRef} (${modelDetails})`, {
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)} (${modelDetails})`,
  });
  const startupDurationMs =
    typeof params.startupStartedAt === "number" ? Date.now() - params.startupStartedAt : null;
  const startupDurationLabel =
    startupDurationMs == null ? null : `${(startupDurationMs / 1000).toFixed(1)}s`;
  params.log.info(
    `http server listening (${formatReadyDetails(params.loadedPluginIds, startupDurationLabel)})`,
  );
  params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
  if (params.isNixMode) {
    params.log.info("gateway: running in Nix mode (config managed externally)");
  }

  for (const warning of await collectConfiguredChannelStartupWarnings({
    cfg: params.cfg,
    activationSourceConfig: params.activationSourceConfig,
  })) {
    params.log.warn(warning);
  }

  const enabledDangerousFlags =
    collectEnabledInsecureOrDangerousFlagsFromCurrentSnapshot(params.cfg) ??
    (await import("../security/dangerous-config-flags.js")).collectEnabledInsecureOrDangerousFlags(
      params.cfg,
    );
  if (enabledDangerousFlags.length > 0) {
    const warning =
      `security warning: dangerous config flags enabled: ${enabledDangerousFlags.join(", ")}. ` +
      "Run `openclaw security audit`.";
    params.log.warn(warning);
  }
}

/** Normalize model thinking values that are useful in the compact startup log. */
function normalizeStartupThinkLevel(value: unknown): StartupThinkLevel | undefined {
  return value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "adaptive" ||
    value === "max" ||
    value === "ultra"
    ? value
    : undefined;
}

/** Resolve explicit thinking overrides from agent defaults and per-model config. */
function resolveExplicitStartupThinking(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  defaultAgentThinking: unknown;
}): StartupThinkLevel | undefined {
  const models = params.cfg.agents?.defaults?.models;
  const canonicalKey = modelKey(params.provider, params.model);
  const legacyKey = legacyModelKey(params.provider, params.model);
  return (
    normalizeStartupThinkLevel(params.defaultAgentThinking) ??
    normalizeStartupThinkLevel(models?.[canonicalKey]?.params?.thinking) ??
    normalizeStartupThinkLevel(legacyKey ? models?.[legacyKey]?.params?.thinking : undefined) ??
    normalizeStartupThinkLevel(params.cfg.agents?.defaults?.thinkingDefault)
  );
}

/** True when a configured catalog entry disables reasoning for the startup model. */
function isConfiguredReasoningDisabled(params: {
  catalog: readonly ModelCatalogEntry[];
  provider: string;
  model: string;
}): boolean {
  return params.catalog.some(
    (entry) =>
      entry.provider === params.provider && entry.id === params.model && entry.reasoning === false,
  );
}

/** Format model thinking and fast-mode details for the Gateway startup banner. */
export function formatAgentModelStartupDetails(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): string {
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const defaultAgentConfig = resolveAgentConfig(params.cfg, defaultAgentId);
  const explicitThinking = resolveExplicitStartupThinking({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    defaultAgentThinking: defaultAgentConfig?.thinkingDefault,
  });
  let thinking = explicitThinking;
  if (thinking === undefined) {
    const configuredCatalog = buildConfiguredModelCatalog({ cfg: params.cfg });
    // Catalog reasoning=false is authoritative; avoid loading provider policy artifacts
    // only to discard their default below.
    if (
      isConfiguredReasoningDisabled({
        catalog: configuredCatalog,
        provider: params.provider,
        model: params.model,
      })
    ) {
      thinking = "off";
    } else {
      const resolvedThinking = resolveThinkingDefault({
        cfg: params.cfg,
        provider: params.provider,
        model: params.model,
        catalog: configuredCatalog,
      });
      thinking = resolvedThinking === "off" ? "medium" : resolvedThinking;
    }
  }
  const fast = resolveFastModeState({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    agentId: defaultAgentId,
  });

  return `thinking=${thinking}, fast=${formatFastModeValue(fast.mode)}`;
}

async function collectConfiguredChannelStartupWarnings(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
}): Promise<string[]> {
  const [blockerModule, presencePolicyModule, pluginRegistryModule] = await Promise.all([
    import("../commands/doctor/shared/channel-plugin-blockers.js"),
    import("../plugins/channel-presence-policy.js"),
    import("../plugins/plugin-registry.js"),
  ]);
  const manifestRegistry = pluginRegistryModule.loadPluginManifestRegistryForPluginRegistry({
    config: params.cfg,
    env: process.env,
    includeDisabled: true,
  });
  const hits = blockerModule.scanConfiguredChannelPluginBlockers(
    params.cfg,
    process.env,
    params.activationSourceConfig,
    { manifestRecords: manifestRegistry.plugins },
  );
  const blockerWarnings = blockerModule
    .collectConfiguredChannelPluginBlockerWarnings(hits)
    .map((warning) => `configured channel warning: ${warning.replace(/^[-]\s*/u, "")}`);
  const missingOwnerWarnings = presencePolicyModule
    .resolveConfiguredChannelPresencePolicy({
      config: params.cfg,
      activationSourceConfig: params.activationSourceConfig,
      includePersistedAuthState: false,
      manifestRecords: manifestRegistry.plugins,
    })
    .filter((entry) => !entry.effective && entry.blockedReasons.includes("no-channel-owner"))
    .map(formatConfiguredChannelMissingOwnerStartupWarning);
  return [...blockerWarnings, ...missingOwnerWarnings];
}

function formatConfiguredChannelMissingOwnerStartupWarning(entry: {
  channelId: string;
  blockedReasons: readonly string[];
}): string {
  const channelId = sanitizeForLog(entry.channelId);
  const reasons = normalizeSortedUniqueStringEntries(entry.blockedReasons).join(", ");
  return (
    `configured channel warning: channels.${channelId} is configured but no channel plugin ` +
    `is installed or loadable (${reasons}). Run \`openclaw doctor --fix\` or install the ` +
    "channel plugin before relying on this channel."
  );
}

/** Format plugin count/list and optional startup duration for the ready log line. */
function formatReadyDetails(
  loadedPluginIds: readonly string[],
  startupDurationLabel: string | null,
) {
  const pluginIds = normalizeSortedUniqueStringEntries(loadedPluginIds);
  const pluginSummary =
    pluginIds.length === 0
      ? "0 plugins"
      : `${pluginIds.length} ${pluginIds.length === 1 ? "plugin" : "plugins"}: ${pluginIds.join(", ")}`;

  if (!startupDurationLabel) {
    return pluginSummary;
  }
  return pluginIds.length === 0
    ? `${pluginSummary}, ${startupDurationLabel}`
    : `${pluginSummary}; ${startupDurationLabel}`;
}
