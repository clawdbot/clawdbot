import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelKey } from "../shared/model-key.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

type ModelExtraParamSources = {
  defaultParams?: Record<string, unknown>;
  modelParams?: Record<string, unknown>;
  agentParams?: Record<string, unknown>;
};

function legacyModelKey(provider: string, modelId: string): string | undefined {
  const rawKey = `${provider.trim()}/${modelId.trim()}`;
  const canonicalKey = modelKey(provider, modelId);
  return rawKey === canonicalKey ? undefined : rawKey;
}

/** Resolves the config records merged into one model request. */
export function resolveModelExtraParamSources(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId?: string;
  agentId?: string;
}): ModelExtraParamSources {
  const defaultParams = params.config?.agents?.defaults?.params;
  const configuredModels = params.config?.agents?.defaults?.models;
  const canonicalKey = params.modelId ? modelKey(params.provider, params.modelId) : undefined;
  const legacyKey = params.modelId ? legacyModelKey(params.provider, params.modelId) : undefined;
  const modelParams = canonicalKey
    ? (configuredModels?.[canonicalKey]?.params ??
      (legacyKey ? configuredModels?.[legacyKey]?.params : undefined))
    : undefined;
  const agentParams =
    params.agentId && params.config
      ? resolveAgentConfig(params.config, params.agentId)?.params
      : undefined;
  return { defaultParams, modelParams, agentParams };
}

/** Returns whether embedded OpenClaw would apply authored request parameters. */
export function hasModelExtraParams(
  params: Parameters<typeof resolveModelExtraParamSources>[0],
): boolean {
  const sources = resolveModelExtraParamSources(params);
  return [sources.defaultParams, sources.modelParams, sources.agentParams].some(
    (source) => source !== undefined && Object.keys(source).length > 0,
  );
}
