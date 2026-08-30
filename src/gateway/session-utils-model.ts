import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import {
  resolveCurrentSessionAgentRuntimeMetadata,
  resolveModelAgentRuntimeMetadata,
} from "../agents/agent-runtime-metadata.js";
import { resolveAgentConfig, resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  findModelCatalogEntry,
  type ModelCatalogEntry,
  modelSupportsInput,
} from "../agents/model-catalog.js";
import { resolveModelContextWindowProfile } from "../agents/model-context-window.js";
import {
  findNormalizedProviderValue,
  inferUniqueProviderFromConfiguredModels,
  isCliProvider,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolveThinkingDefault,
} from "../agents/model-selection.js";
import { resolveThinkingDefaultCore } from "../agents/model-thinking-default-core.js";
import { publishedModelCatalogOwnerMatchesAgent } from "../agents/prepared-model-catalog-owner.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import {
  concretizeAgentRuntime,
  resolveEffectiveAgentRuntime,
} from "../agents/thinking-runtime.js";
import {
  normalizeThinkLevel,
  resolveSupportedThinkingLevel,
  resolveThinkingProfile,
} from "../auto-reply/thinking.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveAgentMainSessionKey, type SessionEntry } from "../config/sessions.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";
import {
  createSessionRowModelCacheKey,
  type GatewayModelThinkingProfile,
  type SessionListRowContext,
} from "./session-utils-contracts.js";
import type { GatewaySessionsDefaults, SessionsPatchResult } from "./session-utils.types.js";
import { projectWorkerPlacementAgentRuntime } from "./worker-environments/placement-session-runtime.js";

type ThinkingProviderPolicySource = NonNullable<
  Parameters<typeof resolveThinkingProfile>[0]["providerPolicySource"]
>;

function listGatewayThinkingLevelOptions(params: {
  provider: string;
  model: string;
  modelCatalog?: ModelCatalogEntry[];
  agentRuntime: string;
  configuredReasoning?: boolean;
  providerPolicySource?: ThinkingProviderPolicySource;
}) {
  return resolveThinkingProfile({
    provider: params.provider,
    model: params.model,
    catalog: params.modelCatalog,
    agentRuntime: params.agentRuntime,
    configuredReasoning: params.configuredReasoning,
    providerPolicySource: params.providerPolicySource,
  }).levels.map(({ id, label }) => ({ id, label }));
}

function resolveGatewaySessionThinkingLevel(params: {
  provider: string;
  catalogProvider?: string;
  model: string;
  level: NonNullable<ReturnType<typeof normalizeThinkLevel>>;
  modelCatalog?: ModelCatalogEntry[];
  agentRuntime: string;
  configuredReasoning?: boolean;
  providerPolicySource?: ThinkingProviderPolicySource;
}) {
  const catalogEntry = params.modelCatalog
    ? findModelCatalogEntry(params.modelCatalog, {
        provider: params.catalogProvider ?? params.provider,
        modelId: params.model,
      })
    : undefined;
  // Lightweight projections can omit the catalog or carry identity-only entries.
  // Runtime/model patches normalize persisted state with authoritative metadata;
  // projections must not reinterpret an already-validated level without it.
  if (
    !catalogEntry ||
    (params.providerPolicySource !== undefined &&
      params.providerPolicySource !== "active-or-bundled" &&
      catalogEntry.reasoning === undefined)
  ) {
    return params.level;
  }
  return resolveSupportedThinkingLevel({
    provider: params.provider,
    model: params.model,
    level: params.level,
    catalog: params.modelCatalog,
    agentRuntime: params.agentRuntime,
    configuredReasoning: params.configuredReasoning,
    providerPolicySource: params.providerPolicySource,
  });
}

function resolveGatewaySessionThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  thinkingPolicyProvider?: string;
  model: string;
  agentId?: string;
  modelCatalog?: ModelCatalogEntry[];
  agentRuntime: string;
  configuredReasoning?: boolean;
  providerPolicySource?: ThinkingProviderPolicySource;
}) {
  const agentThinkingDefault = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.thinkingDefault
    : undefined;
  const resolveDefault =
    params.providerPolicySource !== undefined && params.providerPolicySource !== "active-or-bundled"
      ? (defaultParams: Parameters<typeof resolveThinkingDefault>[0]) =>
          resolveThinkingDefaultCore({
            ...defaultParams,
            providerPolicySource: params.providerPolicySource,
          })
      : resolveThinkingDefault;
  const defaultLevel =
    agentThinkingDefault ??
    resolveDefault({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      catalog: params.modelCatalog,
      agentRuntime: params.agentRuntime,
    });
  return resolveGatewaySessionThinkingLevel({
    provider: params.thinkingPolicyProvider ?? params.provider,
    catalogProvider: params.provider,
    model: params.model,
    level: defaultLevel,
    modelCatalog: params.modelCatalog,
    agentRuntime: params.agentRuntime,
    configuredReasoning: params.configuredReasoning,
    providerPolicySource: params.providerPolicySource,
  });
}

export function resolveGatewayModelThinkingProfile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  model: string;
  agentRuntime?: string;
  configuredReasoning?: boolean;
  thinkingPolicyProvider?: string;
  modelCatalog?: ModelCatalogEntry[];
  rowContext?: SessionListRowContext;
  sessionKey?: string;
  providerPolicySource?: ThinkingProviderPolicySource;
}): GatewayModelThinkingProfile {
  const catalogEntry = params.modelCatalog
    ? findModelCatalogEntry(params.modelCatalog, {
        provider: params.provider,
        modelId: params.model,
      })
    : undefined;
  const agentRuntime =
    params.agentRuntime ??
    resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.model,
      modelApi: catalogEntry?.api,
      modelBaseUrl: catalogEntry?.baseUrl,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
  const thinkingPolicyProvider = params.thinkingPolicyProvider ?? params.provider;
  const policySource =
    typeof params.providerPolicySource === "object" ? "prepared" : params.providerPolicySource;
  const key = `${normalizeAgentId(params.agentId)}\0${agentRuntime}\0${normalizeLowercaseStringOrEmpty(thinkingPolicyProvider)}\0${String(params.configuredReasoning)}\0${policySource ?? "active-or-bundled"}\0${createSessionRowModelCacheKey(
    params.provider,
    params.model,
  )}`;
  const cached = params.rowContext?.thinkingMetadataByModelRef.get(key);
  if (cached) {
    return cached;
  }
  const metadata = {
    thinkingLevels: listGatewayThinkingLevelOptions({
      provider: thinkingPolicyProvider,
      model: params.model,
      modelCatalog: params.modelCatalog,
      agentRuntime,
      configuredReasoning: params.configuredReasoning,
      providerPolicySource: params.providerPolicySource,
    }),
    thinkingDefault: resolveGatewaySessionThinkingDefault({
      cfg: params.cfg,
      provider: params.provider,
      thinkingPolicyProvider,
      model: params.model,
      agentId: params.agentId,
      modelCatalog: params.modelCatalog,
      agentRuntime,
      configuredReasoning: params.configuredReasoning,
      providerPolicySource: params.providerPolicySource,
    }),
  };
  params.rowContext?.thinkingMetadataByModelRef.set(key, metadata);
  return metadata;
}

type GatewaySessionThinkingProjectionParams = {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId: string;
  sessionKey: string;
  entry?: SessionEntry;
  modelCatalog?: ModelCatalogEntry[];
  rowContext?: SessionListRowContext;
  providerPolicySource?: ThinkingProviderPolicySource;
};

export function resolveGatewaySessionThinkingProjectionInternal(
  params: GatewaySessionThinkingProjectionParams,
) {
  const cachedAcpMeta = params.rowContext?.acpSessionMetaByEntry;
  const acpMeta =
    params.entry?.acp ??
    (params.entry && cachedAcpMeta?.has(params.entry)
      ? cachedAcpMeta.get(params.entry)
      : readAcpSessionMeta({ sessionKey: params.sessionKey, agentId: params.agentId }));
  const agentRuntime = resolveCurrentSessionAgentRuntimeMetadata({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    sessionKey: params.sessionKey,
    sessionEntry: params.entry,
    acpRuntime: acpMeta != null,
    acpBackend: acpMeta?.backend,
  });
  const catalogEntry = params.modelCatalog
    ? findModelCatalogEntry(params.modelCatalog, {
        provider: params.provider,
        modelId: params.model,
      })
    : undefined;
  const thinkingRuntime = acpMeta
    ? concretizeAgentRuntime(acpMeta.backend ?? agentRuntime.id)
    : resolveEffectiveAgentRuntime({
        cfg: params.cfg,
        provider: params.provider,
        modelId: params.model,
        modelApi: catalogEntry?.api,
        modelBaseUrl: catalogEntry?.baseUrl,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionEntry: params.entry,
      });
  const metadata = resolveGatewayModelThinkingProfile({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    agentRuntime: thinkingRuntime,
    modelCatalog: params.modelCatalog,
    rowContext: params.rowContext,
    providerPolicySource: params.providerPolicySource,
  });
  const storedThinkingLevel = normalizeThinkLevel(params.entry?.thinkingLevel);
  const thinkingLevel = storedThinkingLevel
    ? resolveGatewaySessionThinkingLevel({
        provider: params.provider,
        model: params.model,
        level: storedThinkingLevel,
        modelCatalog: params.modelCatalog,
        agentRuntime: thinkingRuntime,
        providerPolicySource: params.providerPolicySource,
      })
    : undefined;
  return {
    agentRuntime,
    thinkingLevel,
    effectiveThinkingLevel: thinkingLevel ?? metadata.thinkingDefault,
    // Preserve the established serialized projection order for byte-stable responses.
    thinkingLevels: metadata.thinkingLevels,
    thinkingOptions: metadata.thinkingLevels.map((level) => level.label),
    thinkingDefault: metadata.thinkingDefault,
  };
}

export function getSessionDefaults(
  cfg: OpenClawConfig,
  modelCatalog?: ModelCatalogEntry[],
  options?: {
    agentId?: string;
    allowPluginNormalization?: boolean;
    providerPolicySource?: ThinkingProviderPolicySource;
  },
): GatewaySessionsDefaults {
  const agentId = normalizeAgentId(
    options?.agentId ?? tryResolveLegacyCompatibilityAgentId(cfg) ?? LEGACY_IMPLICIT_AGENT_ID,
  );
  const resolved = options?.agentId
    ? resolveDefaultModelForAgent({
        cfg,
        agentId,
        allowPluginNormalization: options.allowPluginNormalization,
      })
    : resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        allowPluginNormalization: options?.allowPluginNormalization,
      });
  const catalogEntry = modelCatalog
    ? findModelCatalogEntry(modelCatalog, {
        provider: resolved.provider,
        modelId: resolved.model,
      })
    : undefined;
  const contextWindowProfile = resolveModelContextWindowProfile({ catalogEntry });
  const resolvedContextTokens =
    resolveContextTokensForModel({
      cfg,
      provider: resolved.provider,
      model: resolved.model,
      modelContextTokens: catalogEntry?.contextTokens,
      modelContextWindow: contextWindowProfile.contextTokens,
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS;
  const contextTokens = contextWindowProfile.contextTokens
    ? Math.min(resolvedContextTokens, contextWindowProfile.contextTokens)
    : resolvedContextTokens;
  const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const agentRuntime = projectWorkerPlacementAgentRuntime(
    resolveModelAgentRuntimeMetadata({
      cfg,
      agentId,
      provider: resolved.provider,
      model: resolved.model,
      sessionKey,
      acpRuntime: false,
    }),
  );
  const thinkingProfile = resolveGatewayModelThinkingProfile({
    cfg,
    provider: resolved.provider,
    model: resolved.model,
    agentId,
    modelCatalog:
      modelCatalog ??
      (options?.providerPolicySource !== undefined &&
      options.providerPolicySource !== "active-or-bundled"
        ? []
        : undefined),
    sessionKey,
    providerPolicySource: options?.providerPolicySource,
  });
  return {
    modelProvider: resolved.provider ?? null,
    model: resolved.model ?? null,
    contextTokens: contextTokens ?? null,
    contextWindow: contextWindowProfile.contextWindow,
    contextWindows: contextWindowProfile.contextWindows,
    contextWindowDefault: contextWindowProfile.contextWindowDefault,
    agentRuntime,
    // Preserve the established serialized projection order for byte-stable responses.
    thinkingLevels: thinkingProfile.thinkingLevels,
    thinkingOptions: thinkingProfile.thinkingLevels.map((level) => level.label),
    thinkingDefault: thinkingProfile.thinkingDefault,
  };
}

function normalizeGatewayModelCapabilityBaseUrl(value: string | undefined): string | undefined {
  const baseUrl = normalizeOptionalString(value);
  if (!baseUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return parsed.toString();
  } catch {
    return baseUrl.replace(/\/+$/u, "");
  }
}

function isGatewayModelExplicitlyConfiguredTextOnly(params: {
  snapshot: GatewayModelCatalogSnapshot;
  provider?: string;
  model: string;
}): boolean {
  if (!params.provider) {
    return false;
  }
  const configuredModel = findNormalizedProviderValue(
    params.snapshot.config.models?.providers,
    params.provider,
  )?.models?.find(
    (model) =>
      normalizeLowercaseStringOrEmpty(model.id) === normalizeLowercaseStringOrEmpty(params.model),
  );
  return configuredModel?.input !== undefined && !configuredModel.input.includes("image");
}

function resolveGatewayProviderStaticModel(params: {
  snapshot: GatewayModelCatalogSnapshot;
  agentId?: string;
  provider?: string;
  model: string;
  catalogEntry?: ModelCatalogEntry;
}): ModelCatalogEntry | undefined {
  if (
    !params.agentId ||
    !params.provider ||
    !publishedModelCatalogOwnerMatchesAgent(params.snapshot, params.agentId)
  ) {
    return undefined;
  }
  const staticEntry = findModelCatalogEntry(params.snapshot.staticEntries ?? [], {
    provider: params.provider,
    modelId: params.model,
  });
  if (!staticEntry) {
    return undefined;
  }
  if (params.catalogEntry?.api && params.catalogEntry.api !== staticEntry.api) {
    return undefined;
  }
  const catalogBaseUrl = normalizeGatewayModelCapabilityBaseUrl(params.catalogEntry?.baseUrl);
  const staticBaseUrl = normalizeGatewayModelCapabilityBaseUrl(staticEntry.baseUrl);
  if (catalogBaseUrl && catalogBaseUrl !== staticBaseUrl) {
    return undefined;
  }

  if (isGatewayModelExplicitlyConfiguredTextOnly(params)) {
    return undefined;
  }
  const configuredProvider = findNormalizedProviderValue(
    params.snapshot.config.models?.providers,
    params.provider,
  );
  const normalizedModelId = normalizeLowercaseStringOrEmpty(params.model);
  const configuredModel = configuredProvider?.models?.find(
    (model) => normalizeLowercaseStringOrEmpty(model.id) === normalizedModelId,
  );
  const configuredApi = configuredModel?.api ?? configuredProvider?.api;
  if (configuredApi && configuredApi !== staticEntry.api) {
    return undefined;
  }
  const configuredBaseUrl = normalizeGatewayModelCapabilityBaseUrl(
    configuredModel?.baseUrl ?? configuredProvider?.baseUrl,
  );
  if (configuredBaseUrl && configuredBaseUrl !== staticBaseUrl) {
    return undefined;
  }
  return staticEntry;
}

export async function resolveGatewayModelSupportsImages(params: {
  loadGatewayModelCatalog: (params?: {
    agentId?: string;
    readOnly?: boolean;
  }) => Promise<ModelCatalogEntry[]>;
  loadGatewayModelCatalogSnapshot?: (params?: {
    agentId?: string;
    readOnly?: boolean;
  }) => Promise<GatewayModelCatalogSnapshot>;
  agentId?: string;
  provider?: string;
  model?: string;
}): Promise<boolean> {
  if (!params.model) {
    return true;
  }

  try {
    // Attachment admission first consumes lifecycle-prepared capabilities. Runtime-only models
    // retain the evidence-based live fallback without making known models wait for discovery.
    for (const readOnly of [true, false]) {
      const loadParams = {
        ...(params.agentId ? { agentId: params.agentId } : {}),
        readOnly,
      };
      const snapshot = params.loadGatewayModelCatalogSnapshot
        ? await params.loadGatewayModelCatalogSnapshot(loadParams)
        : undefined;
      const catalog = snapshot
        ? snapshot.entries
        : await params.loadGatewayModelCatalog(loadParams);
      const catalogEntry = findModelCatalogEntry(catalog, {
        provider: params.provider,
        modelId: params.model,
      });
      // Same-generation provider facts repair stale discovered capabilities without
      // crossing agent ownership, physical routes, or authored input policy.
      const staticEntry =
        snapshot && (!catalogEntry || !modelSupportsInput(catalogEntry, "image"))
          ? resolveGatewayProviderStaticModel({
              snapshot,
              agentId: params.agentId,
              provider: params.provider,
              model: params.model,
              catalogEntry,
            })
          : undefined;
      const modelEntry = staticEntry ?? catalogEntry;
      const normalizedProvider = normalizeOptionalLowercaseString(
        params.provider ?? modelEntry?.provider,
      );
      const normalizedCandidates = [
        normalizeLowercaseStringOrEmpty(params.model),
        normalizeLowercaseStringOrEmpty(modelEntry?.name),
      ].filter(Boolean);
      if (modelEntry) {
        if (modelSupportsInput(modelEntry, "image")) {
          return true;
        }
        // Legacy safety shim for stale persisted Foundry rows that predate
        // provider-owned capability normalization.
        if (
          normalizedProvider === "microsoft-foundry" &&
          normalizedCandidates.some(
            (candidate) =>
              candidate.startsWith("gpt-") ||
              candidate.startsWith("o1") ||
              candidate.startsWith("o3") ||
              candidate.startsWith("o4") ||
              candidate === "computer-use-preview",
          )
        ) {
          return true;
        }
        if (
          normalizedProvider === "claude-cli" &&
          normalizedCandidates.some(
            (candidate) =>
              candidate === "opus" ||
              candidate === "sonnet" ||
              candidate === "haiku" ||
              candidate.startsWith("claude-"),
          )
        ) {
          return true;
        }
        if (
          readOnly &&
          !snapshot?.catalogComplete &&
          (!snapshot ||
            !isGatewayModelExplicitlyConfiguredTextOnly({
              snapshot,
              provider: params.provider,
              model: params.model,
            }))
        ) {
          continue;
        }
        return false;
      }
      if (
        normalizedProvider === "claude-cli" &&
        normalizedCandidates.some(
          (candidate) =>
            candidate === "opus" ||
            candidate === "sonnet" ||
            candidate === "haiku" ||
            candidate.startsWith("claude-"),
        )
      ) {
        return true;
      }
      if (readOnly && snapshot?.catalogComplete) {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function resolveSessionDisplayModelIdentityRefCached(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  model?: string;
  rowContext?: SessionListRowContext;
}): { provider?: string; model?: string } {
  const ctx = params.rowContext;
  if (!ctx) {
    return resolveSessionDisplayModelIdentityRef(params);
  }
  const key = `${params.agentId}\u0000${createSessionRowModelCacheKey(
    params.provider,
    params.model,
  )}`;
  const cached = ctx.displayModelIdentityByKey.get(key);
  if (cached) {
    return cached;
  }
  const value = resolveSessionDisplayModelIdentityRef(params);
  ctx.displayModelIdentityByKey.set(key, value);
  return value;
}

function resolveSessionDisplayModelIdentityRef(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  model?: string;
}): { provider?: string; model?: string } {
  const provider = normalizeOptionalString(params.provider);
  const model = normalizeOptionalString(params.model);
  if (!provider || !model || !isCliProvider(provider, params.cfg)) {
    return { provider, model };
  }

  const defaultRef = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  if (model.includes("/")) {
    const parsedModel = parseModelRef(model, defaultRef.provider);
    if (parsedModel && !isCliProvider(parsedModel.provider, params.cfg)) {
      return parsedModel;
    }
  }

  const inferredProvider = inferUniqueProviderFromConfiguredModels({
    cfg: params.cfg,
    model,
    agentId: params.agentId,
  });
  if (inferredProvider && !isCliProvider(inferredProvider, params.cfg)) {
    return { provider: inferredProvider, model };
  }

  const parsedModel = parseModelRef(model, defaultRef.provider);
  if (parsedModel && !isCliProvider(parsedModel.provider, params.cfg)) {
    return parsedModel;
  }

  return {
    provider: defaultRef.provider || provider,
    model,
  };
}

export async function projectSessionPatchResult(params: {
  canonicalKey: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
  modelCatalogByAgent: ReadonlyMap<string, Promise<ModelCatalogEntry[]>>;
  storePath: string;
  targetAgentId: string;
}): Promise<SessionsPatchResult> {
  const agentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: params.canonicalKey,
    agentId: params.targetAgentId,
  });
  const resolved = resolveSessionModelRef(params.cfg, params.entry, agentId);
  const displayModel = resolveSessionDisplayModelIdentityRef({
    cfg: params.cfg,
    agentId,
    provider: resolved.provider,
    model: resolved.model,
  });
  const modelCatalog = await params.modelCatalogByAgent.get(params.targetAgentId);
  const thinking = resolveGatewaySessionThinkingProjectionInternal({
    cfg: params.cfg,
    agentId,
    provider: displayModel.provider ?? resolved.provider,
    model: displayModel.model ?? resolved.model,
    sessionKey: params.canonicalKey,
    entry: params.entry,
    modelCatalog,
  });
  const catalogEntry = modelCatalog
    ? findModelCatalogEntry(modelCatalog, {
        provider: displayModel.provider ?? resolved.provider,
        modelId: displayModel.model ?? resolved.model,
      })
    : undefined;
  const contextWindow = resolveModelContextWindowProfile({
    catalogEntry,
    selected: params.entry.contextWindow,
  });
  return {
    ok: true,
    path: resolveSqliteTargetFromSessionStorePath(params.storePath, {
      agentId: params.targetAgentId,
    }).path,
    key: params.canonicalKey,
    entry: projectPublicSessionEntry(params.entry),
    resolved: {
      modelProvider: displayModel.provider,
      model: displayModel.model,
      agentRuntime: thinking.agentRuntime,
      ...(modelCatalog
        ? {
            contextWindow: contextWindow.contextWindow,
            contextWindows: contextWindow.contextWindows,
            thinkingLevel: thinking.effectiveThinkingLevel,
            thinkingLevels: thinking.thinkingLevels,
          }
        : {}),
    },
  };
}
