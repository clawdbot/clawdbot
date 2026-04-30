import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderEndpoint } from "./provider-attribution.js";
import { findNormalizedProviderValue } from "./provider-id.js";

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 4_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 8_000;
export const CONTEXT_WINDOW_HARD_MIN_RATIO = 0.1;
export const CONTEXT_WINDOW_WARN_BELOW_RATIO = 0.2;

export type ContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";

export type ContextWindowInfo = {
  tokens: number;
  referenceTokens?: number;
  source: ContextWindowSource;
};

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

export function resolveContextWindowInfo(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  modelContextTokens?: number;
  modelContextWindow?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  const fromModelsConfig = (() => {
    const providers = params.cfg?.models?.providers as
      | Record<
          string,
          { models?: Array<{ id?: string; contextTokens?: number; contextWindow?: number }> }
        >
      | undefined;
    const providerEntry = findNormalizedProviderValue(providers, params.provider);
    const models = Array.isArray(providerEntry?.models) ? providerEntry.models : [];
    const match = models.find((m) => m?.id === params.modelId);
    return normalizePositiveInt(match?.contextTokens) ?? normalizePositiveInt(match?.contextWindow);
  })();
  const fromModel =
    normalizePositiveInt(params.modelContextTokens) ??
    normalizePositiveInt(params.modelContextWindow);
  const defaultTokens =
    normalizePositiveInt(params.defaultTokens) ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS;
  const baseInfo = fromModelsConfig
    ? { tokens: fromModelsConfig, source: "modelsConfig" as const }
    : fromModel
      ? { tokens: fromModel, source: "model" as const }
      : { tokens: defaultTokens, source: "default" as const };

  const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return { tokens: capTokens, referenceTokens: baseInfo.tokens, source: "agentContextTokens" };
  }

  return baseInfo;
}

export type ContextWindowGuardResult = ContextWindowInfo & {
  hardMinTokens: number;
  warnBelowTokens: number;
  shouldWarn: boolean;
  shouldBlock: boolean;
};

export type ContextWindowGuardThresholds = {
  hardMinTokens: number;
  warnBelowTokens: number;
};

export type ContextWindowGuardHint = {
  endpointClass: ReturnType<typeof resolveProviderEndpoint>["endpointClass"];
  likelySelfHosted: boolean;
};

export function resolveContextWindowGuardHint(params: {
  runtimeBaseUrl?: string | null;
}): ContextWindowGuardHint {
  const endpoint = resolveProviderEndpoint(params.runtimeBaseUrl ?? undefined);
  return {
    endpointClass: endpoint.endpointClass,
    likelySelfHosted: endpoint.endpointClass === "local",
  };
}

export function resolveContextWindowGuardThresholds(
  contextWindowTokens: number,
): ContextWindowGuardThresholds {
  const tokens = normalizePositiveInt(contextWindowTokens) ?? 0;
  return {
    hardMinTokens: Math.max(
      CONTEXT_WINDOW_HARD_MIN_TOKENS,
      Math.floor(tokens * CONTEXT_WINDOW_HARD_MIN_RATIO),
    ),
    warnBelowTokens: Math.max(
      CONTEXT_WINDOW_WARN_BELOW_TOKENS,
      Math.floor(tokens * CONTEXT_WINDOW_WARN_BELOW_RATIO),
    ),
  };
}

export function formatContextWindowWarningMessage(params: {
  provider: string;
  modelId: string;
  guard: ContextWindowGuardResult;
  runtimeBaseUrl?: string | null;
}): string {
  const base = `low context window: ${params.provider}/${params.modelId} ctx=${params.guard.tokens} (warn<${params.guard.warnBelowTokens}) source=${params.guard.source}`;
  const hint = resolveContextWindowGuardHint({ runtimeBaseUrl: params.runtimeBaseUrl });
  if (!hint.likelySelfHosted) {
    return base;
  }
  if (params.guard.source === "agentContextTokens") {
    return (
      `${base}; OpenClaw is capped by agents.defaults.contextTokens, so raise that cap ` +
      `if you want to use more of the model context window`
    );
  }
  if (params.guard.source === "modelsConfig") {
    return (
      `${base}; OpenClaw is using the configured model context limit for this model, ` +
      `so raise contextWindow/contextTokens if it is set too low`
    );
  }
  return (
    `${base}; local/self-hosted runs work best at ` +
    `${params.guard.warnBelowTokens}+ tokens and may show weaker tool use or more compaction until the server/model context limit is raised`
  );
}

export function formatContextWindowBlockMessage(params: {
  guard: ContextWindowGuardResult;
  runtimeBaseUrl?: string | null;
}): string {
  const base =
    `Model context window too small (${params.guard.tokens} tokens; ` +
    `source=${params.guard.source}). Minimum is ${params.guard.hardMinTokens}.`;
  const hint = resolveContextWindowGuardHint({ runtimeBaseUrl: params.runtimeBaseUrl });
  if (!hint.likelySelfHosted) {
    return base;
  }
  if (params.guard.source === "agentContextTokens") {
    return `${base} OpenClaw is capped by agents.defaults.contextTokens. Raise that cap.`;
  }
  if (params.guard.source === "modelsConfig") {
    return (
      `${base} OpenClaw is using the configured model context limit for this model. ` +
      `Raise contextWindow/contextTokens or choose a larger model.`
    );
  }
  return (
    `${base} This looks like a local model endpoint. ` +
    `Raise the server/model context limit or choose a larger model. ` +
    `OpenClaw local/self-hosted runs work best at ${params.guard.warnBelowTokens}+ tokens.`
  );
}

export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const normalizedTokens = normalizePositiveInt(params.info.tokens);
  const tokens = normalizedTokens ?? 0;
  const referenceTokens = normalizePositiveInt(params.info.referenceTokens) ?? tokens;
  const resolvedThresholds = resolveContextWindowGuardThresholds(referenceTokens);
  const warnBelow = Math.max(
    1,
    Math.floor(params.warnBelowTokens ?? resolvedThresholds.warnBelowTokens),
  );
  const defaultHardMin = Math.min(
    resolvedThresholds.hardMinTokens,
    Math.max(tokens, CONTEXT_WINDOW_HARD_MIN_TOKENS),
  );
  const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? defaultHardMin));
  return {
    ...params.info,
    tokens,
    hardMinTokens: hardMin,
    warnBelowTokens: warnBelow,
    shouldWarn: !normalizedTokens || tokens < warnBelow,
    shouldBlock: !normalizedTokens || tokens < hardMin,
  };
}
