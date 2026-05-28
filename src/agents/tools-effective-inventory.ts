import type { OpenClawConfig } from "../config/config.js";
import { extractModelCompat } from "../plugins/provider-model-compat.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { normalizeProviderTransportWithPlugin } from "../plugins/provider-runtime.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { buildPluginToolMetadataKey, getPluginToolMeta } from "../plugins/tools.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveEffectiveToolPolicy } from "./agent-tools.policy.js";
import { getChannelAgentToolMeta } from "./channel-tools.js";
import { resolveModel } from "./embedded-agent-runner/model.js";
import { resolveBundledStaticCatalogModel } from "./embedded-agent-runner/model.static-catalog.js";
import { normalizeStaticProviderModelId } from "./model-ref-shared.js";
import { findNormalizedProviderValue, normalizeProviderId } from "./provider-id.js";
import { normalizeAgentRuntimeTools } from "./runtime-plan/tools.js";
import { summarizeToolDescriptionText } from "./tool-description-summary.js";
import { resolveToolDisplay } from "./tool-display.js";
import { normalizeToolName } from "./tool-policy.js";
import {
  filterRuntimeCompatibleTools,
  type RuntimeToolSchemaDiagnostic,
} from "./tool-schema-projection.js";
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

function resolveEffectiveToolSource(
  tool: AnyAgentTool,
  fallbackTool?: AnyAgentTool,
): {
  source: EffectiveToolSource;
  pluginId?: string;
  channelId?: string;
} {
  const pluginMeta =
    getPluginToolMeta(tool) ?? (fallbackTool ? getPluginToolMeta(fallbackTool) : undefined);
  if (pluginMeta) {
    return { source: "plugin", pluginId: pluginMeta.pluginId };
  }
  const channelMeta =
    getChannelAgentToolMeta(tool as never) ??
    (fallbackTool ? getChannelAgentToolMeta(fallbackTool as never) : undefined);
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

function buildUnsupportedToolSchemaNotice(params: {
  diagnostic: RuntimeToolSchemaDiagnostic;
  tool: AnyAgentTool | undefined;
  fallbackTool: AnyAgentTool | undefined;
}): EffectiveToolInventoryNotice {
  const source = params.tool
    ? resolveEffectiveToolSource(params.tool, params.fallbackTool)
    : { source: "core" as const };
  const owner =
    source.source === "plugin" && source.pluginId
      ? ` from plugin "${source.pluginId}"`
      : source.source === "channel" && source.channelId
        ? ` from channel "${source.channelId}"`
        : "";
  return {
    id: `unsupported-tool-schema:${params.diagnostic.toolName}`,
    severity: "warning",
    message: `Tool "${params.diagnostic.toolName}"${owner} has an unsupported runtime input schema (${params.diagnostic.violations.join(", ")}) and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.`,
  };
}

function buildUnsupportedToolSchemaNotices(params: {
  diagnostics: readonly RuntimeToolSchemaDiagnostic[];
  tools: readonly AnyAgentTool[];
  rawToolsByName: ReadonlyMap<string, AnyAgentTool>;
}): EffectiveToolInventoryNotice[] {
  return params.diagnostics.map((diagnostic) =>
    buildUnsupportedToolSchemaNotice({
      diagnostic,
      tool: params.tools[diagnostic.toolIndex],
      fallbackTool: params.rawToolsByName.get(diagnostic.toolName),
    }),
  );
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

function applyProviderTransportNormalization(params: {
  cfg: OpenClawConfig;
  provider: string;
  workspaceDir?: string;
  runtimeModel: ProviderRuntimeModel;
}): ProviderRuntimeModel {
  const normalized = normalizeProviderTransportWithPlugin({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    context: {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      api: params.runtimeModel.api,
      baseUrl: params.runtimeModel.baseUrl,
    },
  });
  if (!normalized) {
    return params.runtimeModel;
  }
  return {
    ...params.runtimeModel,
    api: normalized.api ?? params.runtimeModel.api,
    baseUrl: normalized.baseUrl ?? params.runtimeModel.baseUrl,
  } as ProviderRuntimeModel;
}

function resolveConfiguredFallbackApi(
  providerConfig: { api?: string; baseUrl?: string } | undefined,
): string {
  const explicitApi = normalizeOptionalString(providerConfig?.api);
  if (explicitApi) {
    return explicitApi;
  }
  return normalizeOptionalString(providerConfig?.baseUrl)
    ? "openai-completions"
    : "openai-responses";
}

function resolveDynamicRuntimeModelContext(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
}): { modelApi?: string; runtimeModel?: ProviderRuntimeModel } {
  const runtimeModel = resolveModel(params.provider, params.modelId, params.agentDir, params.cfg, {
    workspaceDir: params.workspaceDir,
  }).model as ProviderRuntimeModel | undefined;
  if (!runtimeModel) {
    return {};
  }
  return {
    modelApi: runtimeModel.api,
    runtimeModel,
  };
}

export function resolveEffectiveToolInventoryRuntimeModelContext(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  modelProvider?: string;
  modelId?: string;
}): { modelApi?: string; runtimeModel?: ProviderRuntimeModel } {
  const provider = normalizeProviderId(params.modelProvider ?? "");
  const modelId = params.modelId?.trim() ?? "";
  if (!provider || !modelId) {
    return {};
  }
  const agentId = params.agentId?.trim() || resolveSessionAgentId({ config: params.cfg });
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const providerConfig = findNormalizedProviderValue(params.cfg.models?.providers, provider);
  const configuredModels = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
  const normalizedModelId = normalizeStaticProviderModelId(provider, modelId);
  const normalizedModelKey = normalizeLowercaseStringOrEmpty(normalizedModelId);
  const providerPrefixedModelKey = normalizeLowercaseStringOrEmpty(
    `${provider}/${normalizedModelId}`,
  );
  const configuredModel = configuredModels.find((model) => {
    const id = normalizeStaticProviderModelId(provider, model.id);
    const key = normalizeLowercaseStringOrEmpty(id);
    return key === normalizedModelKey || key === providerPrefixedModelKey;
  });
  const bundledStaticModel = resolveBundledStaticCatalogModel({
    provider,
    modelId,
    cfg: params.cfg,
    workspaceDir,
  }) as ProviderRuntimeModel | undefined;
  if (configuredModel) {
    const configuredApi =
      normalizeOptionalString(configuredModel.api) ??
      normalizeOptionalString(providerConfig?.api) ??
      normalizeOptionalString(bundledStaticModel?.api) ??
      resolveConfiguredFallbackApi(providerConfig);
    const runtimeModel = applyProviderTransportNormalization({
      cfg: params.cfg,
      provider,
      workspaceDir,
      runtimeModel: {
        ...bundledStaticModel,
        ...configuredModel,
        id: configuredModel.id,
        name: configuredModel.name ?? bundledStaticModel?.name ?? configuredModel.id,
        provider,
        api: configuredApi,
        baseUrl:
          normalizeOptionalString(configuredModel.baseUrl) ??
          normalizeOptionalString(providerConfig?.baseUrl) ??
          normalizeOptionalString(bundledStaticModel?.baseUrl),
      } as ProviderRuntimeModel,
    });
    return {
      modelApi: runtimeModel.api,
      runtimeModel,
    };
  }
  if (!bundledStaticModel) {
    return resolveDynamicRuntimeModelContext({
      cfg: params.cfg,
      agentDir: params.agentDir,
      workspaceDir,
      provider,
      modelId,
    });
  }
  const runtimeModel = applyProviderTransportNormalization({
    cfg: params.cfg,
    provider,
    workspaceDir,
    runtimeModel: {
      ...bundledStaticModel,
      api: normalizeOptionalString(providerConfig?.api) ?? bundledStaticModel.api,
      baseUrl: normalizeOptionalString(providerConfig?.baseUrl) ?? bundledStaticModel.baseUrl,
    } as ProviderRuntimeModel,
  });
  return {
    modelApi: runtimeModel.api,
    runtimeModel,
  };
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
  const runtimeModelContext =
    params.modelApi || params.runtimeModel
      ? {
          modelApi: params.modelApi ?? params.runtimeModel?.api,
          runtimeModel: params.runtimeModel,
        }
      : resolveEffectiveToolInventoryRuntimeModelContext({
          cfg: params.cfg,
          agentId,
          agentDir,
          workspaceDir,
          modelProvider: params.modelProvider,
          modelId: params.modelId,
        });
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
    modelApi: runtimeModelContext.modelApi,
    modelCompat,
    messageProvider: params.messageProvider,
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
  const rawToolsByName = new Map(effectiveTools.map((tool) => [tool.name, tool]));
  const normalizedEffectiveTools = normalizeAgentRuntimeTools({
    tools: effectiveTools,
    provider: params.modelProvider ?? "",
    config: params.cfg,
    workspaceDir,
    modelId: params.modelId,
    modelApi: runtimeModelContext.modelApi,
    model: runtimeModelContext.runtimeModel,
  });
  const toolSchemaProjection = filterRuntimeCompatibleTools(normalizedEffectiveTools);
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
    toolSchemaProjection.tools
      .map((tool) => {
        const source = resolveEffectiveToolSource(tool, rawToolsByName.get(tool.name));
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
  const notices = [
    ...buildUnsupportedToolSchemaNotices({
      diagnostics: toolSchemaProjection.diagnostics,
      tools: normalizedEffectiveTools,
      rawToolsByName,
    }),
    ...(buildToolInventoryNotices({ cfg: params.cfg, profile, entries, effectivePolicy }) ?? []),
  ];
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

  return { agentId, profile, groups, ...(notices.length > 0 ? { notices } : {}) };
}
