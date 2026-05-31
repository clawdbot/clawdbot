import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/config.js";
import { extractModelCompat } from "../plugins/provider-model-compat.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { normalizeProviderTransportWithPlugin } from "../plugins/provider-runtime.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveEffectiveToolPolicy } from "./agent-tools.policy.js";
import { resolveModel } from "./embedded-agent-runner/model.js";
import { resolveBundledStaticCatalogModel } from "./embedded-agent-runner/model.static-catalog.js";
import { normalizeStaticProviderModelId } from "./model-ref-shared.js";
import { normalizeToolName } from "./tool-policy.js";
import {
  buildEffectiveToolInventoryGroups,
  buildRuntimeCompatibleToolInventory,
} from "./tools-effective-inventory-build.js";
import type {
  EffectiveToolInventoryNotice,
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryResult,
  ResolveEffectiveToolInventoryParams,
} from "./tools-effective-inventory.types.js";

export {
  buildEffectiveToolInventoryEntries,
  buildEffectiveToolInventoryGroups,
  buildRuntimeCompatibleToolInventory,
} from "./tools-effective-inventory-build.js";

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
  });
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
  const projectedInventory = buildRuntimeCompatibleToolInventory({
    tools: effectiveTools,
    cfg: params.cfg,
    workspaceDir,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    modelApi: runtimeModelContext.modelApi,
    runtimeModel: runtimeModelContext.runtimeModel,
  });
  const effectivePolicy = resolveEffectiveToolPolicy({
    config: params.cfg,
    agentId,
    sessionKey: params.sessionKey,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const profile = effectivePolicy.providerProfile ?? effectivePolicy.profile ?? "full";
  const entries = projectedInventory.entries;
  const notices = [
    ...projectedInventory.notices,
    ...(buildToolInventoryNotices({ cfg: params.cfg, profile, entries, effectivePolicy }) ?? []),
  ];
  const groups = buildEffectiveToolInventoryGroups(entries);

  return { agentId, profile, groups, ...(notices.length > 0 ? { notices } : {}) };
}
