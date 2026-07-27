import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { resolveModelAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { lookupContextTokens } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  findModelCatalogEntry,
  type ModelCatalogEntry,
  modelSupportsInput,
} from "../agents/model-catalog.js";
import {
  inferUniqueProviderFromConfiguredModels,
  isCliProvider,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolveThinkingDefault,
} from "../agents/model-selection.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import {
  concretizeAgentRuntime,
  resolveEffectiveAgentRuntime,
} from "../agents/thinking-runtime.js";
import {
  listThinkingLevelOptions,
  normalizeThinkLevel,
  resolveSupportedThinkingLevel,
} from "../auto-reply/thinking.js";
import { resolveAgentMainSessionKey, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  createSessionRowModelCacheKey,
  type SessionListRowContext,
} from "./session-utils-contracts.js";
import type { GatewaySessionsDefaults } from "./session-utils.types.js";

function resolveGatewaySessionThinkingLevel(params: {
  provider: string;
  model: string;
  level: NonNullable<ReturnType<typeof normalizeThinkLevel>>;
  modelCatalog?: ModelCatalogEntry[];
  agentRuntime: string;
}) {
  const catalogEntry = params.modelCatalog
    ? findModelCatalogEntry(params.modelCatalog, {
        provider: params.provider,
        modelId: params.model,
      })
    : undefined;
  // Lightweight sessions.changed projections intentionally omit the catalog.
  // Runtime/model patches normalize persisted state with authoritative metadata;
  // projections must not reinterpret an already-validated level without it.
  if (!catalogEntry) {
    return params.level;
  }
  return resolveSupportedThinkingLevel({
    provider: params.provider,
    model: params.model,
    level: params.level,
    catalog: params.modelCatalog,
    agentRuntime: params.agentRuntime,
  });
}

export function resolveGatewaySessionThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId?: string;
  modelCatalog?: ModelCatalogEntry[];
  agentRuntime: string;
}) {
  const agentThinkingDefault = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.thinkingDefault
    : undefined;
  const defaultLevel =
    agentThinkingDefault ??
    resolveThinkingDefault({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      catalog: params.modelCatalog,
      agentRuntime: params.agentRuntime,
    });
  return resolveGatewaySessionThinkingLevel({
    provider: params.provider,
    model: params.model,
    level: defaultLevel,
    modelCatalog: params.modelCatalog,
    agentRuntime: params.agentRuntime,
  });
}

function resolveSessionRowThinkingMetadata(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  model: string;
  agentRuntime: string;
  modelCatalog?: ModelCatalogEntry[];
  rowContext?: SessionListRowContext;
}): {
  levels: ReturnType<typeof listThinkingLevelOptions>;
  defaultLevel: ReturnType<typeof resolveGatewaySessionThinkingDefault>;
} {
  if (!params.rowContext) {
    return {
      levels: listThinkingLevelOptions(
        params.provider,
        params.model,
        params.modelCatalog,
        params.agentRuntime,
      ),
      defaultLevel: resolveGatewaySessionThinkingDefault({
        cfg: params.cfg,
        provider: params.provider,
        model: params.model,
        agentId: params.agentId,
        modelCatalog: params.modelCatalog,
        agentRuntime: params.agentRuntime,
      }),
    };
  }
  const key = `${normalizeAgentId(params.agentId)}\0${params.agentRuntime}\0${createSessionRowModelCacheKey(
    params.provider,
    params.model,
  )}`;
  const cached = params.rowContext.thinkingMetadataByModelRef.get(key);
  if (cached) {
    return cached;
  }
  const metadata = {
    levels: listThinkingLevelOptions(
      params.provider,
      params.model,
      params.modelCatalog,
      params.agentRuntime,
    ),
    defaultLevel: resolveGatewaySessionThinkingDefault({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      agentId: params.agentId,
      modelCatalog: params.modelCatalog,
      agentRuntime: params.agentRuntime,
    }),
  };
  params.rowContext.thinkingMetadataByModelRef.set(key, metadata);
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
};

export function resolveGatewaySessionThinkingProjectionInternal(
  params: GatewaySessionThinkingProjectionParams,
) {
  const acpMeta = readAcpSessionMeta({ sessionKey: params.sessionKey });
  const configuredAgentRuntime = resolveModelAgentRuntimeMetadata({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    sessionKey: params.sessionKey,
    acpRuntime: acpMeta != null,
    acpBackend: acpMeta?.backend,
  });
  const persistedAgentRuntime = resolveSessionRuntimeOverrideForProvider({
    provider: params.provider,
    entry: params.entry,
    cfg: params.cfg,
  });
  const persistedAgentRuntimeSource: "session" | "session-key" =
    params.entry?.modelSelectionLocked === true ? "session" : "session-key";
  const agentRuntime =
    acpMeta || !persistedAgentRuntime
      ? configuredAgentRuntime
      : {
          id: persistedAgentRuntime,
          source: persistedAgentRuntimeSource,
        };
  const thinkingRuntime = acpMeta
    ? concretizeAgentRuntime(acpMeta.backend ?? agentRuntime.id)
    : resolveEffectiveAgentRuntime({
        cfg: params.cfg,
        provider: params.provider,
        modelId: params.model,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionEntry: params.entry,
      });
  const metadata = resolveSessionRowThinkingMetadata({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    agentRuntime: thinkingRuntime,
    modelCatalog: params.modelCatalog,
    rowContext: params.rowContext,
  });
  const storedThinkingLevel = normalizeThinkLevel(params.entry?.thinkingLevel);
  const thinkingLevel = storedThinkingLevel
    ? resolveGatewaySessionThinkingLevel({
        provider: params.provider,
        model: params.model,
        level: storedThinkingLevel,
        modelCatalog: params.modelCatalog,
        agentRuntime: thinkingRuntime,
      })
    : undefined;
  return {
    agentRuntime,
    thinkingLevel,
    effectiveThinkingLevel: thinkingLevel ?? metadata.defaultLevel,
    thinkingLevels: metadata.levels,
    thinkingOptions: metadata.levels.map((level) => level.label),
    thinkingDefault: metadata.defaultLevel,
  };
}

/** Resolve the canonical runtime, selected level, and picker metadata for a session. */
export function resolveGatewaySessionThinkingProjection(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId: string;
  sessionKey: string;
  entry?: SessionEntry;
  modelCatalog?: ModelCatalogEntry[];
}) {
  return resolveGatewaySessionThinkingProjectionInternal(params);
}

export function getSessionDefaults(
  cfg: OpenClawConfig,
  modelCatalog?: ModelCatalogEntry[],
  options?: { allowPluginNormalization?: boolean },
): GatewaySessionsDefaults {
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    allowPluginNormalization: options?.allowPluginNormalization,
  });
  const contextTokens =
    cfg.agents?.defaults?.contextTokens ??
    lookupContextTokens(resolved.model, { allowAsyncLoad: false }) ??
    DEFAULT_CONTEXT_TOKENS;
  const agentId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const agentRuntime = resolveModelAgentRuntimeMetadata({
    cfg,
    agentId,
    provider: resolved.provider,
    model: resolved.model,
    sessionKey,
    acpRuntime: false,
  });
  const thinkingRuntime = resolveEffectiveAgentRuntime({
    cfg,
    provider: resolved.provider,
    modelId: resolved.model,
    agentId,
    sessionKey,
  });
  const thinkingLevels = listThinkingLevelOptions(
    resolved.provider,
    resolved.model,
    modelCatalog,
    thinkingRuntime,
  );
  return {
    modelProvider: resolved.provider ?? null,
    model: resolved.model ?? null,
    contextTokens: contextTokens ?? null,
    agentRuntime,
    thinkingLevels,
    thinkingOptions: thinkingLevels.map((level) => level.label),
    thinkingDefault: resolveGatewaySessionThinkingDefault({
      cfg,
      provider: resolved.provider,
      model: resolved.model,
      modelCatalog,
      agentRuntime: thinkingRuntime,
    }),
  };
}

export async function resolveGatewayModelSupportsImages(params: {
  loadGatewayModelCatalog: (params?: { readOnly?: boolean }) => Promise<ModelCatalogEntry[]>;
  provider?: string;
  model?: string;
}): Promise<boolean> {
  if (!params.model) {
    return true;
  }

  try {
    const catalog = await params.loadGatewayModelCatalog({ readOnly: false });
    const modelEntry = findModelCatalogEntry(catalog, {
      provider: params.provider,
      modelId: params.model,
    });
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

export function resolveSessionDisplayModelIdentityRef(params: {
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
