import { resolveAgentConfig } from "../../../agents/agent-scope-config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { parseModelRef } from "../../../agents/model-selection-normalize.js";
import { normalizeProviderId } from "../../../agents/provider-id.js";
import { pickSandboxToolPolicy } from "../../../agents/sandbox-tool-policy.js";
import { isToolAllowedByPolicies } from "../../../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../../agents/tool-policy.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AgentToolsConfig, ToolsConfig } from "../../../config/types.tools.js";
import { collectChannelRouteTargets } from "../../../routing/channel-route-targets.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";

type ChannelDoctorModule = typeof import("./channel-doctor.js");

const channelDoctorModuleLoader = createLazyImportLoader<ChannelDoctorModule>(
  () => import("./channel-doctor.js"),
);

function loadChannelDoctorModule(): Promise<ChannelDoctorModule> {
  return channelDoctorModuleLoader.load();
}

function hasRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function listAgentRecords(cfg: OpenClawConfig): Record<string, unknown>[] {
  return Array.isArray(cfg.agents?.list) ? cfg.agents.list.filter(hasRecord) : [];
}

function hasChannels(cfg: OpenClawConfig): boolean {
  return hasRecord(cfg.channels);
}

function hasPlugins(cfg: OpenClawConfig): boolean {
  return hasRecord(cfg.plugins);
}

function hasPluginLoadPaths(cfg: OpenClawConfig): boolean {
  const plugins = cfg.plugins;
  if (!hasRecord(plugins)) {
    return false;
  }
  const load = plugins.load;
  return hasRecord(load) && Array.isArray(load.paths) && load.paths.length > 0;
}

function hasExplicitChannelPluginBlockerConfig(cfg: OpenClawConfig): boolean {
  if (cfg.plugins?.enabled === false) {
    return true;
  }
  const entries = cfg.plugins?.entries;
  if (!hasRecord(entries)) {
    return false;
  }
  return Object.values(entries).some(
    (entry) => hasRecord(entry) && "enabled" in entry && entry.enabled === false,
  );
}

function hasToolsBySenderKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasToolsBySenderKey);
  }
  if (!hasRecord(value)) {
    return false;
  }
  if (hasRecord(value.toolsBySender)) {
    return true;
  }
  return Object.entries(value).some(
    ([key, nested]) => key !== "toolsBySender" && hasToolsBySenderKey(nested),
  );
}

function hasConfiguredSafeBins(cfg: OpenClawConfig): boolean {
  const globalExec = cfg.tools?.exec;
  if (
    hasRecord(globalExec) &&
    Array.isArray(globalExec.safeBins) &&
    globalExec.safeBins.length > 0
  ) {
    return true;
  }
  return listAgentRecords(cfg).some((agent) => {
    const agentExec = hasRecord(agent) && hasRecord(agent.tools) ? agent.tools.exec : undefined;
    return (
      hasRecord(agentExec) && Array.isArray(agentExec.safeBins) && agentExec.safeBins.length > 0
    );
  });
}

type VisibleReplyPolicyProvenance = "default" | "global-explicit" | "group-explicit";
type ToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  profile?: string;
};

function normalizeProviderPolicyKey(value: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0) {
    return normalizeProviderId(normalized);
  }
  const provider = normalizeProviderId(normalized.slice(0, slashIndex));
  const modelId = normalized.slice(slashIndex + 1);
  return modelId ? `${provider}/${modelId}` : provider;
}

function isCanonicalProviderPolicyKey(value: string): boolean {
  return normalizeLowercaseStringOrEmpty(value) === normalizeProviderPolicyKey(value);
}

function resolveProviderToolPolicy(params: {
  byProvider?: Record<string, ToolPolicyConfig>;
  modelProvider: string;
  modelId: string;
}): ToolPolicyConfig | undefined {
  if (!params.byProvider) {
    return undefined;
  }
  const lookup = new Map<string, { canonical: boolean; value: ToolPolicyConfig }>();
  for (const [key, value] of Object.entries(params.byProvider)) {
    const normalized = normalizeProviderPolicyKey(key);
    if (!normalized) {
      continue;
    }
    const canonical = isCanonicalProviderPolicyKey(key);
    const existing = lookup.get(normalized);
    if (!existing || (canonical && !existing.canonical)) {
      lookup.set(normalized, { canonical, value });
    }
  }

  const provider = normalizeProviderPolicyKey(params.modelProvider);
  const modelId = normalizeLowercaseStringOrEmpty(params.modelId);
  const fullModelId = modelId ? `${provider}/${modelId}` : undefined;
  return (fullModelId ? lookup.get(fullModelId)?.value : undefined) ?? lookup.get(provider)?.value;
}

function resolveMessageToolAvailability(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  globalTools?: ToolsConfig;
  agentTools?: AgentToolsConfig;
  runtimeAlsoAllow?: string[];
}): boolean {
  const agentConfig = params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
  const modelRef = resolvePrimaryModelRef(params.cfg, agentConfig?.model);
  const providerPolicy = resolveProviderToolPolicy({
    byProvider: params.globalTools?.byProvider,
    modelProvider: modelRef.provider,
    modelId: modelRef.model,
  });
  const agentProviderPolicy = resolveProviderToolPolicy({
    byProvider: params.agentTools?.byProvider,
    modelProvider: modelRef.provider,
    modelId: modelRef.model,
  });
  const profile = params.agentTools?.profile ?? params.globalTools?.profile;
  const configuredAlsoAllow = Array.isArray(params.agentTools?.alsoAllow)
    ? params.agentTools.alsoAllow
    : Array.isArray(params.globalTools?.alsoAllow)
      ? params.globalTools.alsoAllow
      : [];
  const providerAlsoAllow = Array.isArray(agentProviderPolicy?.alsoAllow)
    ? agentProviderPolicy.alsoAllow
    : Array.isArray(providerPolicy?.alsoAllow)
      ? providerPolicy.alsoAllow
      : [];
  const profileAlsoAllow = [...configuredAlsoAllow, ...(params.runtimeAlsoAllow ?? [])];
  const providerProfileAlsoAllow = [...providerAlsoAllow, ...(params.runtimeAlsoAllow ?? [])];
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), profileAlsoAllow);
  const providerProfilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(agentProviderPolicy?.profile ?? providerPolicy?.profile),
    providerProfileAlsoAllow,
  );
  return isToolAllowedByPolicies("message", [
    profilePolicy,
    providerProfilePolicy,
    pickSandboxToolPolicy(providerPolicy),
    pickSandboxToolPolicy(agentProviderPolicy),
    pickSandboxToolPolicy(params.globalTools),
    pickSandboxToolPolicy(params.agentTools),
  ]);
}

const SOURCE_REPLY_RUNTIME_MESSAGE_ALLOW = ["message"];

function resolvePrimaryModelRef(
  cfg: OpenClawConfig,
  agentModel?: NonNullable<ReturnType<typeof resolveAgentConfig>>["model"],
): { provider: string; model: string } {
  const raw =
    resolveAgentModelPrimaryValue(agentModel) ??
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ??
    DEFAULT_MODEL;
  return (
    parseModelRef(raw, DEFAULT_PROVIDER, { allowPluginNormalization: false }) ?? {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
    }
  );
}

function resolveSourceReplyMessageToolAvailability(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  globalTools?: ToolsConfig;
  agentTools?: AgentToolsConfig;
}): boolean {
  return resolveMessageToolAvailability({
    ...params,
    runtimeAlsoAllow: SOURCE_REPLY_RUNTIME_MESSAGE_ALLOW,
  });
}

function sourceReplyRuntimeMayAllowMessageTool(cfg: OpenClawConfig): boolean {
  const groupPolicy = resolveGroupVisibleReplyProvenance(cfg);
  if (hasChannels(cfg) && groupPolicy.value === "message_tool") {
    return true;
  }
  if (cfg.messages?.visibleReplies === "message_tool") {
    return true;
  }
  return false;
}

function collectMessageToolUnavailableTargets(
  cfg: OpenClawConfig,
  options: { sourceReplyRuntimeGrant?: boolean } = {},
): string[] {
  const agents = listAgentRecords(cfg);
  if (agents.length === 0) {
    const available = options.sourceReplyRuntimeGrant
      ? resolveSourceReplyMessageToolAvailability({ cfg, globalTools: cfg.tools })
      : resolveMessageToolAvailability({ cfg, globalTools: cfg.tools });
    return available ? [] : ["default tool policy"];
  }
  return agents.flatMap((agent) => {
    const agentId = typeof agent.id === "string" ? agent.id : "unknown";
    const available = options.sourceReplyRuntimeGrant
      ? resolveSourceReplyMessageToolAvailability({
          cfg,
          agentId,
          globalTools: cfg.tools,
          agentTools: agent.tools as AgentToolsConfig | undefined,
        })
      : resolveMessageToolAvailability({
          cfg,
          agentId,
          globalTools: cfg.tools,
          agentTools: agent.tools as AgentToolsConfig | undefined,
        });
    return available ? [] : [`agent "${agentId}"`];
  });
}

function resolveGroupVisibleReplyProvenance(cfg: OpenClawConfig): {
  path: "messages.groupChat.visibleReplies" | "messages.visibleReplies";
  provenance: VisibleReplyPolicyProvenance;
  value: "automatic" | "message_tool";
} {
  const groupVisibleReplies = cfg.messages?.groupChat?.visibleReplies;
  if (groupVisibleReplies) {
    return {
      path: "messages.groupChat.visibleReplies",
      provenance: "group-explicit",
      value: groupVisibleReplies,
    };
  }
  const globalVisibleReplies = cfg.messages?.visibleReplies;
  if (globalVisibleReplies) {
    return {
      path: "messages.visibleReplies",
      provenance: "global-explicit",
      value: globalVisibleReplies,
    };
  }
  return {
    path: "messages.groupChat.visibleReplies",
    provenance: "default",
    value: "message_tool",
  };
}

function formatTargets(targets: string[]): string {
  if (targets.length <= 2) {
    return targets.join(" and ");
  }
  return `${targets.slice(0, 2).join(", ")}, and ${targets.length - 2} more`;
}

export function collectVisibleReplyToolPolicyWarnings(cfg: OpenClawConfig): string[] {
  const groupPolicy = resolveGroupVisibleReplyProvenance(cfg);
  const warnings: string[] = [];
  if (groupPolicy.value === "message_tool") {
    if (groupPolicy.provenance === "default" && !hasChannels(cfg)) {
      return warnings;
    }
    const targets = collectMessageToolUnavailableTargets(cfg, { sourceReplyRuntimeGrant: true });
    if (targets.length === 0) {
      return warnings;
    }
    const targetSummary = formatTargets(targets);
    if (groupPolicy.provenance === "default") {
      warnings.push(
        `- messages.groupChat.visibleReplies defaults to "message_tool", but the message tool is unavailable for ${targetSummary}; OpenClaw falls back to automatic group/channel replies to avoid silent responses. Enable the message tool or set messages.groupChat.visibleReplies explicitly.`,
      );
    } else {
      warnings.push(
        `- ${groupPolicy.path} is set to "message_tool", but the message tool is unavailable for ${targetSummary}; OpenClaw falls back to automatic visible replies, so normal replies may post to the source chat. Enable the message tool or set ${groupPolicy.path} to "automatic".`,
      );
    }
  }

  const globalVisibleReplies = cfg.messages?.visibleReplies;
  if (globalVisibleReplies === "message_tool" && groupPolicy.path !== "messages.visibleReplies") {
    const targets = collectMessageToolUnavailableTargets(cfg, { sourceReplyRuntimeGrant: true });
    if (targets.length === 0) {
      return warnings;
    }
    warnings.push(
      `- messages.visibleReplies is set to "message_tool", but the message tool is unavailable for ${formatTargets(
        targets,
      )}; OpenClaw falls back to automatic direct-chat replies, so normal replies may post to the source chat. Enable the message tool or set messages.visibleReplies to "automatic".`,
    );
  }
  return warnings;
}

function formatChannelList(channels: string[]): string {
  if (channels.length <= 2) {
    return channels.map((channel) => `"${channel}"`).join(" and ");
  }
  return `${channels
    .slice(0, 2)
    .map((channel) => `"${channel}"`)
    .join(", ")}, and ${channels.length - 2} more`;
}

export function collectChannelBoundMessageToolPolicyWarnings(cfg: OpenClawConfig): string[] {
  return collectChannelRouteTargets(cfg).flatMap((target) => {
    const agentTools = resolveAgentConfig(cfg, target.agentId)?.tools;
    const runtimeMayAllowMessage = sourceReplyRuntimeMayAllowMessageTool(cfg);
    const messageToolAvailable = runtimeMayAllowMessage
      ? resolveSourceReplyMessageToolAvailability({
          cfg,
          agentId: target.agentId,
          globalTools: cfg.tools,
          agentTools,
        })
      : resolveMessageToolAvailability({
          cfg,
          agentId: target.agentId,
          globalTools: cfg.tools,
          agentTools,
        });
    if (messageToolAvailable) {
      return [];
    }
    return [
      `- Agent "${target.agentId}" is routed from channel ${formatChannelList(
        target.channels,
      )}, but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.`,
    ];
  });
}

export async function collectDoctorPreviewWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const hasChannelConfig = hasChannels(params.cfg);
  const hasPluginConfig = hasPlugins(params.cfg);

  warnings.push(...collectVisibleReplyToolPolicyWarnings(params.cfg));
  warnings.push(...collectChannelBoundMessageToolPolicyWarnings(params.cfg));

  const channelPluginRuntime =
    hasChannelConfig && hasExplicitChannelPluginBlockerConfig(params.cfg)
      ? await import("./channel-plugin-blockers.js")
      : undefined;
  const channelPluginBlockerHits =
    channelPluginRuntime?.scanConfiguredChannelPluginBlockers(params.cfg, env) ?? [];
  if (channelPluginRuntime && channelPluginBlockerHits.length > 0) {
    warnings.push(
      channelPluginRuntime
        .collectConfiguredChannelPluginBlockerWarnings(channelPluginBlockerHits)
        .join("\n"),
    );
  }

  if (hasChannelConfig) {
    const { collectChannelDoctorPreviewWarnings } = await loadChannelDoctorModule();
    const channelDoctorWarnings = await collectChannelDoctorPreviewWarnings({
      cfg: params.cfg,
      doctorFixCommand: params.doctorFixCommand,
      env,
    });
    if (channelDoctorWarnings.length > 0) {
      warnings.push(...channelDoctorWarnings);
    }

    const { collectOpenPolicyAllowFromWarnings, maybeRepairOpenPolicyAllowFrom } =
      await import("./open-policy-allowfrom.js");
    const allowFromScan = maybeRepairOpenPolicyAllowFrom(params.cfg);
    if (allowFromScan.changes.length > 0) {
      warnings.push(
        collectOpenPolicyAllowFromWarnings({
          changes: allowFromScan.changes,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }
  }

  if ((hasPluginConfig || hasChannelConfig) && params.cfg.plugins?.enabled !== false) {
    const {
      collectStalePluginConfigWarnings,
      isStalePluginAutoRepairBlocked,
      scanStalePluginConfig,
    } = await import("./stale-plugin-config.js");
    const stalePluginHits = scanStalePluginConfig(params.cfg, env);
    if (stalePluginHits.length > 0) {
      warnings.push(
        collectStalePluginConfigWarnings({
          hits: stalePluginHits,
          doctorFixCommand: params.doctorFixCommand,
          autoRepairBlocked: isStalePluginAutoRepairBlocked(params.cfg, env),
        }).join("\n"),
      );
    }
  }

  if (hasPluginConfig) {
    const { collectCodexRouteWarnings } = await import("./codex-route-warnings.js");
    warnings.push(...collectCodexRouteWarnings({ cfg: params.cfg, env }));
  }
  const { collectCodexNativeAssetWarnings } = await import("./codex-native-assets.js");
  warnings.push(...(await collectCodexNativeAssetWarnings({ cfg: params.cfg, env })));

  if (hasPluginLoadPaths(params.cfg)) {
    const { collectBundledPluginLoadPathWarnings, scanBundledPluginLoadPathMigrations } =
      await import("./bundled-plugin-load-paths.js");
    const bundledPluginLoadPathHits = scanBundledPluginLoadPathMigrations(params.cfg, env);
    if (bundledPluginLoadPathHits.length > 0) {
      warnings.push(
        collectBundledPluginLoadPathWarnings({
          hits: bundledPluginLoadPathHits,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }
  }

  if (hasChannelConfig) {
    const { createChannelDoctorEmptyAllowlistPolicyHooks } = await loadChannelDoctorModule();
    const { scanEmptyAllowlistPolicyWarnings } = await import("./empty-allowlist-scan.js");
    const emptyAllowlistHooks = createChannelDoctorEmptyAllowlistPolicyHooks({
      cfg: params.cfg,
      env,
    });
    const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(params.cfg, {
      doctorFixCommand: params.doctorFixCommand,
      extraWarningsForAccount: emptyAllowlistHooks.extraWarningsForAccount,
      shouldSkipDefaultEmptyGroupAllowlistWarning:
        emptyAllowlistHooks.shouldSkipDefaultEmptyGroupAllowlistWarning,
    }).filter(
      (warning) =>
        !(
          channelPluginRuntime?.isWarningBlockedByChannelPlugin(
            warning,
            channelPluginBlockerHits,
          ) ?? false
        ),
    );
    if (emptyAllowlistWarnings.length > 0) {
      const { sanitizeForLog } = await import("../../../terminal/ansi.js");
      warnings.push(emptyAllowlistWarnings.map((line) => sanitizeForLog(line)).join("\n"));
    }
  }

  if (hasToolsBySenderKey(params.cfg)) {
    const { collectLegacyToolsBySenderWarnings, scanLegacyToolsBySenderKeys } =
      await import("./legacy-tools-by-sender.js");
    const toolsBySenderHits = scanLegacyToolsBySenderKeys(params.cfg);
    if (toolsBySenderHits.length > 0) {
      warnings.push(
        collectLegacyToolsBySenderWarnings({
          hits: toolsBySenderHits,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }
  }

  if (hasConfiguredSafeBins(params.cfg)) {
    const {
      collectExecSafeBinCoverageWarnings,
      collectExecSafeBinTrustedDirHintWarnings,
      scanExecSafeBinCoverage,
      scanExecSafeBinTrustedDirHints,
    } = await import("./exec-safe-bins.js");
    const safeBinCoverage = scanExecSafeBinCoverage(params.cfg);
    if (safeBinCoverage.length > 0) {
      warnings.push(
        collectExecSafeBinCoverageWarnings({
          hits: safeBinCoverage,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }

    const safeBinTrustedDirHints = scanExecSafeBinTrustedDirHints(params.cfg);
    if (safeBinTrustedDirHints.length > 0) {
      warnings.push(collectExecSafeBinTrustedDirHintWarnings(safeBinTrustedDirHints).join("\n"));
    }
  }

  const { collectStaleOAuthProfileShadowWarnings, scanStaleOAuthProfileShadows } =
    await import("./stale-oauth-profile-shadows.js");
  const staleOAuthProfileShadows = await scanStaleOAuthProfileShadows({
    cfg: params.cfg,
    env,
  });
  if (staleOAuthProfileShadows.length > 0) {
    warnings.push(
      collectStaleOAuthProfileShadowWarnings({
        hits: staleOAuthProfileShadows,
        doctorFixCommand: params.doctorFixCommand,
      }).join("\n"),
    );
  }

  return warnings;
}
