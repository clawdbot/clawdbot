import { normalizeFastMode } from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelKey } from "../shared/model-key.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

type ModelExtraParamSources = {
  defaultParams?: Record<string, unknown>;
  modelParams?: Record<string, unknown>;
  agentEntryParams?: Record<string, unknown>;
  paramSources: Array<Record<string, unknown> | undefined>;
};

const FAST_MODE_MODEL_PARAM_KEYS = ["fastMode", "fast_mode"] as const;
const FAST_MODE_CUTOFF_MODEL_PARAM_KEYS = [
  "fastAutoOnSeconds",
  "fast_auto_on_seconds",
  "fastSeconds",
  "fast_seconds",
] as const;
const FAST_MODE_CUTOFF_MODEL_PARAM_KEY_SET = new Set<string>(FAST_MODE_CUTOFF_MODEL_PARAM_KEYS);

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
  if (FAST_MODE_MODEL_PARAM_KEYS.some((candidate) => candidate === key)) {
    return normalizeFastMode(value) !== undefined;
  }
  return (
    FAST_MODE_CUTOFF_MODEL_PARAM_KEY_SET.has(key) &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
  );
}

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
  const agentConfig =
    params.agentId && params.config ? resolveAgentConfig(params.config, params.agentId) : undefined;
  const agentEntryParams = agentConfig?.params;
  // Per-agent model entries own catalog and runtime policy. Their `params`
  // shape is not a provider-request precedence scope.
  const paramSources = [defaultParams, modelParams, agentEntryParams];
  return { defaultParams, modelParams, agentEntryParams, paramSources };
}

function resolveModelExtraParamEntryFromSources(
  sources: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[],
  accepts?: (value: unknown) => boolean,
): { key: string; value: unknown; sourceIndex: number } | undefined {
  for (let sourceIndex = sources.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    const source = sources[sourceIndex];
    for (const key of keys) {
      if (!source || !Object.hasOwn(source, key)) {
        continue;
      }
      const value = source[key];
      if (!accepts || accepts(value)) {
        return { key, value, sourceIndex };
      }
    }
  }
  return undefined;
}

/** Resolves the effective parameter set with the winning config scope retained. */
export function resolveEffectiveModelExtraParams(sources: ModelExtraParamSources): Array<{
  key: string;
  effectiveKey: string;
  value: unknown;
  sourceIndex: number;
}> {
  const effective = new Map<
    string,
    { key: string; effectiveKey: string; value: unknown; sourceIndex: number }
  >();
  sources.paramSources.forEach((source, sourceIndex) => {
    for (const [key, value] of Object.entries(source ?? {})) {
      effective.set(key, { key, effectiveKey: key, value, sourceIndex });
    }
  });
  return [...effective.values()];
}

/** Resolves one authored parameter across the canonical config precedence. */
export function resolveModelExtraParamValue(
  params: Parameters<typeof resolveModelExtraParamSources>[0],
  key: string | readonly string[],
  accepts?: (value: unknown) => boolean,
): unknown {
  const sources = resolveModelExtraParamSources(params);
  return resolveModelExtraParamEntryFromSources(
    sources.paramSources,
    typeof key === "string" ? [key] : key,
    accepts,
  )?.value;
}

/** Returns whether embedded OpenClaw would apply authored provider request parameters. */
export function hasAuthoredProviderRequestParams(
  params: Parameters<typeof resolveModelExtraParamSources>[0],
): boolean {
  const sources = resolveModelExtraParamSources(params);
  // Only model-scoped typed controls are route-neutral. Global and agent params
  // remain authored provider behavior so existing configs do not switch runtimes.
  return resolveEffectiveModelExtraParams(sources).some(
    ({ effectiveKey, value, sourceIndex }) =>
      sourceIndex !== 1 || !isAgentRuntimeModelParam(effectiveKey, value),
  );
}
