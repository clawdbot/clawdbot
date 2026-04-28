import type { OpenClawConfig } from "../config/config.js";
import { extractModelCompat } from "../plugins/provider-model-compat.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { buildPluginToolMetadataKey, getPluginToolMeta } from "../plugins/tools.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { getChannelAgentToolMeta } from "./channel-tools.js";
import { normalizeStaticProviderModelId } from "./model-ref-shared.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import { resolveEffectiveToolPolicy } from "./pi-tools.policy.js";
import { findNormalizedProviderValue, normalizeProviderId } from "./provider-id.js";
import { summarizeToolDescriptionText } from "./tool-description-summary.js";
import { resolveToolDisplay } from "./tool-display.js";
import { normalizeToolName } from "./tool-policy.js";
import type {
  EffectiveToolInventoryNotice,
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryGroup,
  EffectiveToolInventoryResult,
  EffectiveToolSource,
  ResolveEffectiveToolInventoryParams,
} from "./tools-effective-inventory.types.js";
import type { AnyAgentTool } from "./tools/common.js";

function resolveEffectiveToolLabel(tool: AnyAgentTool): string {
  const rawLabel = normalizeOptionalString(tool.label) ?? "";
  if (
    rawLabel &&
    normalizeLowercaseStringOrEmpty(rawLabel) !== normalizeLowercaseStringOrEmpty(tool.name)
  ) {
    return rawLabel;
  }
  return resolveToolDisplay({ name: tool.name }).title;
}

function resolveRawToolDescription(tool: AnyAgentTool): string {
  return normalizeOptionalString(tool.description) ?? "";
}

function summarizeToolDescription(tool: AnyAgentTool): string {
  return summarizeToolDescriptionText({
    rawDescription: resolveRawToolDescription(tool),
    displaySummary: tool.displaySummary,
  });
}

function resolveEffectiveToolSource(tool: AnyAgentTool): {
  source: EffectiveToolSource;
  pluginId?: string;
  channelId?: string;
} {
  const pluginMeta = getPluginToolMeta(tool);
  if (pluginMeta) {
    return { source: "plugin", pluginId: pluginMeta.pluginId };
  }
  const channelMeta = getChannelAgentToolMeta(tool as never);
  if (channelMeta) {
    return { source: "channel", channelId: channelMeta.channelId };
  }
  return { source: "core" };
}

function groupLabel(source: EffectiveToolSource): string {
  switch (source) {
    case "plugin":
      return "Connected tools";
    case "channel":
      return "Channel tools";
    default:
      return "Built-in tools";
  }
}

function listIncludesTool(list: string[] | undefined, toolName: string): boolean {
  if (!Array.isArray(list)) {
    return false;
  }
  const normalizedToolName = normalizeToolName(toolName);
  return list.some((entry) => normalizeToolName(entry) === normalizedToolName);
}

function policyDeniesTool(policy: { deny?: string[] } | undefined, toolName: string): boolean {
  return (
    listIncludesTool(policy?.deny, toolName) ||
    listIncludesTool(policy?.deny, "group:ui") ||
    listIncludesTool(policy?.deny, "group:openclaw")
  );
}

function hasExplicitBrowserIntent(cfg: OpenClawConfig): boolean {
  return cfg.browser?.enabled !== false && Boolean(cfg.browser || cfg.plugins?.entries?.browser);
}

function buildToolInventoryNotices(params: {
  cfg: OpenClawConfig;
  profile: string;
  entries: EffectiveToolInventoryEntry[];
  effectivePolicy: ReturnType<typeof resolveEffectiveToolPolicy>;
}): EffectiveToolInventoryNotice[] | undefined {
  const hasBrowserTool = params.entries.some((entry) => normalizeToolName(entry.id) === "browser");
  if (hasBrowserTool || !hasExplicitBrowserIntent(params.cfg)) {
    return undefined;
  }

  const browserDenied = [
    params.effectivePolicy.globalPolicy,
    params.effectivePolicy.globalProviderPolicy,
    params.effectivePolicy.agentPolicy,
    params.effectivePolicy.agentProviderPolicy,
  ].some((policy) => policyDeniesTool(policy, "browser"));
  if (browserDenied) {
    return [
      {
        id: "browser-denied-by-policy",
        severity: "info",
        message:
          "Browser is configured, but this session does not expose the browser tool because tool policy denies it. Remove the browser deny entry to use browser automation.",
      },
    ];
  }

  if (params.profile !== "full") {
    return [
      {
        id: "browser-filtered-by-profile",
        severity: "info",
        message:
          'Browser is configured, but the current tool profile does not include the browser tool. Add tools.alsoAllow: ["browser"] or agents.list[].tools.alsoAllow: ["browser"]; tools.subagents.tools.allow alone cannot add it back after profile filtering.',
      },
    ];
  }

  if (
    Array.isArray(params.cfg.plugins?.allow) &&
    !listIncludesTool(params.cfg.plugins.allow, "browser")
  ) {
    return [
      {
        id: "browser-plugin-not-allowed",
        severity: "warning",
        message:
          'Browser is configured, but plugins.allow does not include browser. Add "browser" to plugins.allow or remove the restrictive plugin allowlist.',
      },
    ];
  }

  return undefined;
}

function disambiguateLabels(entries: EffectiveToolInventoryEntry[]): EffectiveToolInventoryEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  }
  return entries.map((entry) => {
    if ((counts.get(entry.label) ?? 0) < 2) {
      return entry;
    }
    const suffix = entry.pluginId ?? entry.channelId ?? entry.id;
    return { ...entry, label: `${entry.label} (${suffix})` };
  });
}

function resolveEffectiveModelCompat(params: {
  cfg: OpenClawConfig;
  modelProvider?: string;
  modelId?: string;
}) {
  const provider = normalizeProviderId(params.modelProvider ?? "");
  const modelId = params.modelId?.trim() ?? "";
  if (!provider || !modelId) {
    return undefined;
  }
  const providerConfig = findNormalizedProviderValue(params.cfg.models?.providers, provider);
  const models = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
  if (models.length === 0) {
    return undefined;
  }
  const normalizedModelId = normalizeStaticProviderModelId(provider, modelId);
  const normalizedModelKey = normalizeLowercaseStringOrEmpty(normalizedModelId);
  const providerPrefixedModelKey = normalizeLowercaseStringOrEmpty(
    `${provider}/${normalizedModelId}`,
  );
  const match = models.find((model) => {
    const id = normalizeStaticProviderModelId(provider, model.id);
    const key = normalizeLowercaseStringOrEmpty(id);
    return key === normalizedModelKey || key === providerPrefixedModelKey;
  });
  return extractModelCompat(match);
}

export function resolveEffectiveToolInventory(
  params: ResolveEffectiveToolInventoryParams,
): EffectiveToolInventoryResult {
  const agentId =
    params.agentId?.trim() ||
    resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg });
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const agentDir = params.agentDir ?? resolveAgentDir(params.cfg, agentId);
  const modelCompat = resolveEffectiveModelCompat({
    cfg: params.cfg,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });

  const effectiveTools = createOpenClawCodingTools({
    agentId,
    sessionKey: params.sessionKey,
    workspaceDir,
    agentDir,
    config: params.cfg,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    modelCompat,
    messageProvider: params.messageProvider,
    senderIsOwner: params.senderIsOwner,
    senderId: params.senderId,
    senderName: params.senderName ?? undefined,
    senderUsername: params.senderUsername ?? undefined,
    senderE164: params.senderE164 ?? undefined,
    agentAccountId: params.accountId ?? undefined,
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    groupId: params.groupId ?? undefined,
    groupChannel: params.groupChannel ?? undefined,
    groupSpace: params.groupSpace ?? undefined,
    replyToMode: params.replyToMode,
    allowGatewaySubagentBinding: true,
    modelHasVision: params.modelHasVision,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    disableMessageTool: params.disableMessageTool,
  });
  const effectivePolicy = resolveEffectiveToolPolicy({
    config: params.cfg,
    agentId,
    sessionKey: params.sessionKey,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const profile = effectivePolicy.providerProfile ?? effectivePolicy.profile ?? "full";
  // Key metadata by plugin ownership and tool name so only the owning plugin can
  // project display/risk metadata for its own tool.
  const pluginToolMetadata = new Map(
    (getActivePluginRegistry()?.toolMetadata ?? []).map((entry) => [
      buildPluginToolMetadataKey(entry.pluginId, entry.metadata.toolName),
      entry.metadata,
    ]),
  );

  const entries = disambiguateLabels(
    effectiveTools
      .map((tool) => {
        const source = resolveEffectiveToolSource(tool);
        const metadata = source.pluginId
          ? pluginToolMetadata.get(buildPluginToolMetadataKey(source.pluginId, tool.name))
          : undefined;
        return Object.assign(
          {
            id: tool.name,
            label:
              normalizeOptionalString(metadata?.displayName) ?? resolveEffectiveToolLabel(tool),
            description:
              normalizeOptionalString(metadata?.description) ?? summarizeToolDescription(tool),
            rawDescription:
              normalizeOptionalString(metadata?.description) ??
              resolveRawToolDescription(tool) ??
              summarizeToolDescription(tool),
            ...(metadata?.risk ? { risk: metadata.risk } : {}),
            ...(metadata?.tags ? { tags: metadata.tags } : {}),
          },
          source,
        ) satisfies EffectiveToolInventoryEntry;
      })
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  );
  const notices = buildToolInventoryNotices({ cfg: params.cfg, profile, entries, effectivePolicy });
  const groupsBySource = new Map<EffectiveToolSource, EffectiveToolInventoryEntry[]>();
  for (const entry of entries) {
    const tools = groupsBySource.get(entry.source) ?? [];
    tools.push(entry);
    groupsBySource.set(entry.source, tools);
  }

  const groups = (["core", "plugin", "channel"] as const)
    .map((source) => {
      const tools = groupsBySource.get(source);
      if (!tools || tools.length === 0) {
        return null;
      }
      return {
        id: source,
        label: groupLabel(source),
        source,
        tools,
      } satisfies EffectiveToolInventoryGroup;
    })
    .filter((group): group is EffectiveToolInventoryGroup => group !== null);

  return { agentId, profile, groups, ...(notices ? { notices } : {}) };
}
