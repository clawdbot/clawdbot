import { resolveAgentConfig } from "../agents/agent-scope-config.js";
/**
 * Model display resolution for session listings.
 *
 * Session rows may carry persisted model/provider overrides or CLI-runtime
 * model strings; this module normalizes them into display-ready model refs.
 */
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  inferUniqueProviderFromConfiguredModels,
  isCliProvider,
  normalizeStoredOverrideModel,
  parseModelRef,
  resolvePersistedSelectedModelRef,
  type CliProviderClassifier,
} from "../agents/model-selection.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type SessionDisplayModelRow = {
  key: string;
  model?: string;
  modelProvider?: string;
  modelOverride?: string;
  providerOverride?: string;
};

type SessionDisplayDefaults = {
  model: string;
};

type SessionDisplayModelRef = { provider: string; model: string };

function resolveAgentPrimaryModel(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): string | undefined {
  if (!agentId) {
    return undefined;
  }
  return resolveAgentModelPrimaryValue(resolveAgentConfig(cfg, agentId)?.model);
}

function resolveDefaultModelRef(cfg: OpenClawConfig, agentId?: string): SessionDisplayModelRef {
  const primary =
    resolveAgentPrimaryModel(cfg, agentId) ??
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ??
    DEFAULT_MODEL;
  return (
    parseModelRef(primary, DEFAULT_PROVIDER, {
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    }) ?? { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }
  );
}

/** Resolves default display values for a session table scoped to an agent. */
export function resolveSessionDisplayDefaults(
  cfg: OpenClawConfig,
  agentId?: string,
): SessionDisplayDefaults {
  return {
    model: resolveDefaultModelRef(cfg, agentId).model,
  };
}

function normalizeCliRuntimeDisplayRef(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  ref: SessionDisplayModelRef,
  defaultRef: SessionDisplayModelRef,
  classifyCliProvider: CliProviderClassifier,
): SessionDisplayModelRef {
  if (!classifyCliProvider(ref.provider)) {
    return ref;
  }
  const parsed = parseModelRef(ref.model, defaultRef.provider, {
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  });
  if (ref.model.includes("/") && parsed) {
    // CLI runtimes can store the real provider/model inside the model field;
    // prefer that embedded provider when it is not another CLI runtime alias.
    if (!classifyCliProvider(parsed.provider)) {
      return parsed;
    }
  }
  const inferredProvider = inferUniqueProviderFromConfiguredModels({
    cfg,
    model: ref.model,
    agentId,
  });
  if (inferredProvider && !classifyCliProvider(inferredProvider)) {
    return { provider: inferredProvider, model: ref.model };
  }
  // If the CLI runtime model cannot be mapped to a concrete provider, fall
  // back to the configured default provider so rows stay comparable.
  if (parsed && !classifyCliProvider(parsed.provider)) {
    return parsed;
  }
  return {
    provider: defaultRef.provider || ref.provider,
    model: parsed?.model || ref.model,
  };
}

/** Resolves only the model id to show for a session row. */
export function resolveSessionDisplayModel(
  cfg: OpenClawConfig,
  row: SessionDisplayModelRow,
  classifyCliProvider?: CliProviderClassifier,
): string {
  return resolveSessionDisplayModelRef(cfg, row, classifyCliProvider).model;
}

/** Resolves provider/model display metadata for a session row. */
export function resolveSessionDisplayModelRef(
  cfg: OpenClawConfig,
  row: SessionDisplayModelRow,
  classifyCliProvider: CliProviderClassifier = (provider) => isCliProvider(provider, cfg),
  ownerAgentId?: string,
): SessionDisplayModelRef {
  const agentId =
    ownerAgentId ?? (row.key.startsWith("agent:") ? row.key.split(":")[1] : undefined);
  const defaultRef = resolveDefaultModelRef(cfg, agentId);
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: row.providerOverride,
    modelOverride: row.modelOverride,
  });
  const persistedRef = resolvePersistedSelectedModelRef({
    defaultProvider: defaultRef.provider,
    runtimeProvider: row.modelProvider,
    runtimeModel: row.model,
    overrideProvider: normalizedOverride.providerOverride,
    overrideModel: normalizedOverride.modelOverride,
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  });
  if (!persistedRef) {
    return defaultRef;
  }
  return normalizedOverride.modelOverride
    ? persistedRef
    : normalizeCliRuntimeDisplayRef(cfg, agentId, persistedRef, defaultRef, classifyCliProvider);
}
