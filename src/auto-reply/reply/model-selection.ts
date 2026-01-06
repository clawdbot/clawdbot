import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  type ModelAliasIndex,
  modelKey,
  resolveModelRefFromString,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { type SessionEntry, saveSessionStore } from "../../config/sessions.js";
import type { ThinkLevel } from "./directives.js";

export type ModelDirectiveSelection = {
  provider: string;
  model: string;
  isDefault: boolean;
  alias?: string;
};

type ModelCatalog = Awaited<ReturnType<typeof loadModelCatalog>>;

type ModelSelectionState = {
  provider: string;
  model: string;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: ModelCatalog;
  resetModelOverride: boolean;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  needsModelCatalog: boolean;
};

export async function createModelSelectionState(params: {
  cfg: ClawdbotConfig;
  agentCfg: ClawdbotConfig["agent"] | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultProvider: string;
  defaultModel: string;
  provider: string;
  model: string;
  hasModelDirective: boolean;
}): Promise<ModelSelectionState> {
  const {
    cfg,
    agentCfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultProvider,
  } = params;

  let provider = params.provider;
  let model = params.model;

  const hasAllowlist =
    agentCfg?.models && Object.keys(agentCfg.models).length > 0;
  const hasStoredOverride = Boolean(
    sessionEntry?.modelOverride || sessionEntry?.providerOverride,
  );
  const needsModelCatalog =
    params.hasModelDirective || hasAllowlist || hasStoredOverride;

  let allowedModelKeys = new Set<string>();
  let allowedModelCatalog: ModelCatalog = [];
  let modelCatalog: ModelCatalog | null = null;
  let resetModelOverride = false;

  if (needsModelCatalog) {
    modelCatalog = await loadModelCatalog({ config: cfg });
    const allowed = buildAllowedModelSet({
      cfg,
      catalog: modelCatalog,
      defaultProvider,
    });
    allowedModelCatalog = allowed.allowedCatalog;
    allowedModelKeys = allowed.allowedKeys;
  }

  if (sessionEntry && sessionStore && sessionKey && hasStoredOverride) {
    const overrideProvider =
      sessionEntry.providerOverride?.trim() || defaultProvider;
    const overrideModel = sessionEntry.modelOverride?.trim();
    if (overrideModel) {
      const key = modelKey(overrideProvider, overrideModel);
      if (allowedModelKeys.size > 0 && !allowedModelKeys.has(key)) {
        delete sessionEntry.providerOverride;
        delete sessionEntry.modelOverride;
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        if (storePath) {
          await saveSessionStore(storePath, sessionStore);
        }
        resetModelOverride = true;
      }
    }
  }

  const storedProviderOverride = sessionEntry?.providerOverride?.trim();
  const storedModelOverride = sessionEntry?.modelOverride?.trim();
  if (storedModelOverride) {
    const candidateProvider = storedProviderOverride || defaultProvider;
    const key = modelKey(candidateProvider, storedModelOverride);
    if (allowedModelKeys.size === 0 || allowedModelKeys.has(key)) {
      provider = candidateProvider;
      model = storedModelOverride;
    }
  }

  if (
    sessionEntry &&
    sessionStore &&
    sessionKey &&
    sessionEntry.authProfileOverride
  ) {
    const { ensureAuthProfileStore } = await import(
      "../../agents/auth-profiles.js"
    );
    const store = ensureAuthProfileStore();
    const profile = store.profiles[sessionEntry.authProfileOverride];
    if (!profile || profile.provider !== provider) {
      delete sessionEntry.authProfileOverride;
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    }
  }

  let defaultThinkingLevel: ThinkLevel | undefined;
  const resolveDefaultThinkingLevel = async () => {
    if (defaultThinkingLevel) return defaultThinkingLevel;
    let catalogForThinking = modelCatalog ?? allowedModelCatalog;
    if (!catalogForThinking || catalogForThinking.length === 0) {
      modelCatalog = await loadModelCatalog({ config: cfg });
      catalogForThinking = modelCatalog;
    }
    defaultThinkingLevel = resolveThinkingDefault({
      cfg,
      provider,
      model,
      catalog: catalogForThinking,
    });
    return defaultThinkingLevel;
  };

  return {
    provider,
    model,
    allowedModelKeys,
    allowedModelCatalog,
    resetModelOverride,
    resolveDefaultThinkingLevel,
    needsModelCatalog,
  };
}

export function resolveModelDirectiveSelection(params: {
  raw: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
}): { selection?: ModelDirectiveSelection; error?: string } {
  const { raw, defaultProvider, defaultModel, aliasIndex, allowedModelKeys } =
    params;
  const resolved = resolveModelRefFromString({
    raw,
    defaultProvider,
    aliasIndex,
  });
  if (!resolved) {
    return {
      error: `Unrecognized model "${raw}". Use /model to list available models.`,
    };
  }
  const key = modelKey(resolved.ref.provider, resolved.ref.model);
  if (allowedModelKeys.size > 0 && !allowedModelKeys.has(key)) {
    return {
      error: `Model "${resolved.ref.provider}/${resolved.ref.model}" is not allowed. Use /model to list available models.`,
    };
  }
  const isDefault =
    resolved.ref.provider === defaultProvider &&
    resolved.ref.model === defaultModel;
  return {
    selection: {
      provider: resolved.ref.provider,
      model: resolved.ref.model,
      isDefault,
      alias: resolved.alias,
    },
  };
}

export function resolveContextTokens(params: {
  agentCfg: ClawdbotConfig["agent"] | undefined;
  model: string;
}): number {
  return (
    params.agentCfg?.contextTokens ??
    lookupContextTokens(params.model) ??
    DEFAULT_CONTEXT_TOKENS
  );
}
