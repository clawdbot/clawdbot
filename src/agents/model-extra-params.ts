import { normalizeFastMode } from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import { resolveAgentModelConfigEntry } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

type ModelExtraParamSources = {
  defaultParams?: Record<string, unknown>;
  modelParams?: Record<string, unknown>;
  agentParams?: Record<string, unknown>;
};

const FAST_MODE_CUTOFF_MODEL_PARAM_KEYS = new Set([
  "fastAutoOnSeconds",
  "fastSeconds",
  "fast_auto_on_seconds",
  "fast_seconds",
]);

// Native harnesses receive recognized values as typed run controls. Other value
// shapes with the same keys remain authored provider request parameters.
export function isAgentRuntimeModelParam(key: string, value: unknown): boolean {
  if (key === "thinking") {
    return (
      value === false ||
      value === "disabled" ||
      value === "none" ||
      (typeof value === "string" && normalizeThinkLevel(value) !== undefined)
    );
  }
  if (key === "fastMode" || key === "fast_mode") {
    return normalizeFastMode(value) !== undefined;
  }
  return (
    FAST_MODE_CUTOFF_MODEL_PARAM_KEYS.has(key) &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
  );
}

/** Resolves the config records merged into one model request. */
export function resolveModelExtraParamSources(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId?: string;
  agentId?: string;
}): ModelExtraParamSources {
  const defaultParams = params.config?.agents?.defaults?.params;
  const modelParams = params.modelId
    ? resolveAgentModelConfigEntry({
        models: params.config?.agents?.defaults?.models,
        provider: params.provider,
        model: params.modelId,
      }).entry?.params
    : undefined;
  const agentParams =
    params.agentId && params.config
      ? resolveAgentConfig(params.config, params.agentId)?.params
      : undefined;
  return { defaultParams, modelParams, agentParams };
}

/** Returns whether embedded OpenClaw would apply authored provider request parameters. */
export function hasAuthoredProviderRequestParams(
  params: Parameters<typeof resolveModelExtraParamSources>[0],
): boolean {
  const sources = resolveModelExtraParamSources(params);
  if (
    [sources.defaultParams, sources.agentParams].some(
      (source) => source !== undefined && Object.keys(source).length > 0,
    )
  ) {
    return true;
  }
  return Object.entries(sources.modelParams ?? {}).some(
    ([key, value]) => !isAgentRuntimeModelParam(key, value),
  );
}
