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

function parseModelRef(raw: string, defaultProvider: string): SessionDisplayModelRef {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { provider: defaultProvider, model: DEFAULT_MODEL };
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return { provider: defaultProvider, model: trimmed };
  }
  return {
    provider: trimmed.slice(0, slashIndex).trim() || defaultProvider,
    model: trimmed.slice(slashIndex + 1).trim() || DEFAULT_MODEL,
  };
}

function resolveAgentPrimaryModel(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): string | undefined {
  if (!agentId) {
    return undefined;
  }
  return resolveAgentModelPrimaryValue(resolveAgentConfig(cfg, agentId)?.model);
}

function normalizeStoredOverrideModel(params: {
  providerOverride?: string;
  modelOverride?: string;
}): { providerOverride?: string; modelOverride?: string } {
  const providerOverride = params.providerOverride?.trim();
  const modelOverride = params.modelOverride?.trim();
  if (!providerOverride || !modelOverride) {
    return { providerOverride, modelOverride };
  }

  const providerPrefix = `${providerOverride.toLowerCase()}/`;
  // Older stores sometimes persisted both providerOverride and a
  // provider/model modelOverride; trim the duplicate provider for display.
  return {
    providerOverride,
    modelOverride: modelOverride.toLowerCase().startsWith(providerPrefix)
      ? modelOverride.slice(providerOverride.length + 1).trim() || modelOverride
      : modelOverride,
  };
}

function resolveDefaultModelRef(cfg: OpenClawConfig, agentId?: string): SessionDisplayModelRef {
  const primary =
    resolveAgentPrimaryModel(cfg, agentId) ??
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ??
    DEFAULT_MODEL;
  return parseModelRef(primary, DEFAULT_PROVIDER);
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
  ref: SessionDisplayModelRef,
  defaultRef: SessionDisplayModelRef,
): SessionDisplayModelRef {
  if (!isCliProvider(ref.provider, cfg)) {
    return ref;
  }
  if (ref.model.includes("/")) {
    // CLI runtimes can store the real provider/model inside the model field;
    // prefer that embedded provider when it is not another CLI runtime alias.
    const parsed = parseModelRef(ref.model, defaultRef.provider);
    if (!isCliProvider(parsed.provider, cfg)) {
      return parsed;
    }
  }
  const inferredProvider = inferUniqueProviderFromConfiguredModels({
    cfg,
    model: ref.model,
  });
  if (inferredProvider && !isCliProvider(inferredProvider, cfg)) {
    return { provider: inferredProvider, model: ref.model };
  }
  // If the CLI runtime model cannot be mapped to a concrete provider, fall
  // back to the configured default provider so rows stay comparable.
  const parsed = parseModelRef(ref.model, defaultRef.provider);
  if (!isCliProvider(parsed.provider, cfg)) {
    return parsed;
  }
  return {
    provider: defaultRef.provider || ref.provider,
    model: parsed.model || ref.model,
  };
}

/** Resolves only the model id to show for a session row. */
export function resolveSessionDisplayModel(
  cfg: OpenClawConfig,
  row: SessionDisplayModelRow,
): string {
  return resolveSessionDisplayModelRef(cfg, row).model;
}

/** Resolves provider/model display metadata for a session row. */
export function resolveSessionDisplayModelRef(
  cfg: OpenClawConfig,
  row: SessionDisplayModelRow,
): SessionDisplayModelRef {
  const agentId = row.key.startsWith("agent:") ? row.key.split(":")[1] : undefined;
  const defaultRef = resolveDefaultModelRef(cfg, agentId);
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: row.providerOverride,
    modelOverride: row.modelOverride,
  });

  if (normalizedOverride.modelOverride) {
    return parseModelRef(
      normalizedOverride.modelOverride,
      normalizedOverride.providerOverride ?? defaultRef.provider,
    );
  }
  if (row.model) {
    return normalizeCliRuntimeDisplayRef(
      cfg,
      parseModelRef(row.model, row.modelProvider ?? defaultRef.provider),
      defaultRef,
    );
  }
  return defaultRef;
}
