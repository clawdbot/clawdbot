import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderEndpoint } from "./provider-attribution.js";
import { findNormalizedProviderValue } from "./provider-id.js";

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

export type ContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";

export type ContextWindowInfo = {
  tokens: number;
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
  const baseInfo = fromModelsConfig
    ? { tokens: fromModelsConfig, source: "modelsConfig" as const }
    : fromModel
      ? { tokens: fromModel, source: "model" as const }
      : { tokens: Math.floor(params.defaultTokens), source: "default" as const };

  const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return { tokens: capTokens, source: "agentContextTokens" };
  }

  return baseInfo;
}

export type ContextWindowGuardResult = ContextWindowInfo & {
  shouldWarn: boolean;
  shouldBlock: boolean;
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

export function formatContextWindowWarningMessage(params: {
  provider: string;
  modelId: string;
  guard: ContextWindowGuardResult;
  runtimeBaseUrl?: string | null;
}): string {
  const base = `low context window: ${params.provider}/${params.modelId} ctx=${params.guard.tokens} (warn<${CONTEXT_WINDOW_WARN_BELOW_TOKENS}) source=${params.guard.source}`;
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
    `${CONTEXT_WINDOW_WARN_BELOW_TOKENS}+ tokens and may show weaker tool use or more compaction until the server/model context limit is raised`
  );
}

export function formatContextWindowBlockMessage(params: {
  guard: ContextWindowGuardResult;
  runtimeBaseUrl?: string | null;
}): string {
  const base =
    `Model context window too small (${params.guard.tokens} tokens; ` +
    `source=${params.guard.source}). Minimum is ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`;
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
    `OpenClaw local/self-hosted runs work best at ${CONTEXT_WINDOW_WARN_BELOW_TOKENS}+ tokens.`
  );
}

export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const warnBelow = Math.max(
    1,
    Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS),
  );
  const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS));
  const tokens = Math.max(0, Math.floor(params.info.tokens));
  return {
    ...params.info,
    tokens,
    shouldWarn: tokens > 0 && tokens < warnBelow,
    shouldBlock: tokens > 0 && tokens < hardMin,
  };
}
