import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
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

function parseModelRef(raw: string, defaultProvider: string): { provider: string; model: string } {
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
  const agentConfig = cfg.agents?.list?.find((agent) => agent.id === agentId);
  return resolveAgentModelPrimaryValue(agentConfig?.model);
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
  return {
    providerOverride,
    modelOverride: modelOverride.toLowerCase().startsWith(providerPrefix)
      ? modelOverride.slice(providerOverride.length + 1).trim() || modelOverride
      : modelOverride,
  };
}

function resolveDefaultModelRef(
  cfg: OpenClawConfig,
  agentId?: string,
): { provider: string; model: string } {
  const primary =
    resolveAgentPrimaryModel(cfg, agentId) ??
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ??
    DEFAULT_MODEL;
  return parseModelRef(primary, DEFAULT_PROVIDER);
}

export function resolveSessionDisplayDefaults(
  cfg: OpenClawConfig,
  agentId?: string,
): SessionDisplayDefaults {
  return {
    model: resolveDefaultModelRef(cfg, agentId).model,
  };
}

export function resolveSessionDisplayModel(
  cfg: OpenClawConfig,
  row: SessionDisplayModelRow,
): string {
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
    ).model;
  }
  if (row.model) {
    return parseModelRef(row.model, row.modelProvider ?? defaultRef.provider).model;
  }
  return defaultRef.model;
}
