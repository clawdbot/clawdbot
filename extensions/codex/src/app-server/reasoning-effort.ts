import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";

const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

const GPT_56_MAX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const GPT_56_ULTRA_REASONING_EFFORTS = [...GPT_56_MAX_REASONING_EFFORTS, "ultra"] as const;
const GPT_5_PRO_REASONING_EFFORTS = ["medium", "high", "xhigh"] as const;
const GPT_56_ULTRA_MODEL_IDS = new Set(["gpt-5.6-sol", "gpt-5.6-terra"]);
const GPT_56_MAX_MODEL_IDS = new Set([...GPT_56_ULTRA_MODEL_IDS, "gpt-5.6-luna"]);
const MODERN_CODEX_MODEL_IDS = new Set([
  ...GPT_56_MAX_MODEL_IDS,
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
]);

function normalizeCodexReasoningEfforts(
  efforts: readonly string[] | null | undefined,
): CodexReasoningEffort[] {
  if (!efforts) {
    return [];
  }
  const supported = new Set(efforts.map((effort) => effort.trim().toLowerCase()));
  return CODEX_REASONING_EFFORTS.filter((effort) => supported.has(effort));
}

/** Read reasoning metadata after the Codex app-server route has been selected. */
export function readCodexSupportedReasoningEfforts(compat: unknown): string[] | undefined {
  if (!compat || typeof compat !== "object" || Array.isArray(compat)) {
    return undefined;
  }
  const efforts = (compat as { supportedReasoningEfforts?: unknown }).supportedReasoningEfforts;
  if (!Array.isArray(efforts)) {
    return undefined;
  }
  return efforts.filter((effort): effort is string => typeof effort === "string");
}

function resolveSupportedReasoningEffort(params: {
  requested: CodexReasoningEffort;
  supportedReasoningEfforts: readonly string[];
}): CodexReasoningEffort | undefined {
  const supported = normalizeCodexReasoningEfforts(params.supportedReasoningEfforts);
  if (supported.includes(params.requested)) {
    return params.requested;
  }
  // Ultra enables proactive multi-agent behavior, so it must be explicit.
  // Lower-effort fallback may select Max or below, never Ultra.
  const fallbackEfforts =
    params.requested === "ultra" ? supported : supported.filter((effort) => effort !== "ultra");
  const requestedRank = CODEX_REASONING_EFFORTS.indexOf(params.requested);
  return (
    fallbackEfforts.find((effort) => CODEX_REASONING_EFFORTS.indexOf(effort) >= requestedRank) ??
    fallbackEfforts.at(-1)
  );
}

function resolveFallbackReasoningEfforts(
  modelId: string,
): readonly CodexReasoningEffort[] | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (GPT_56_ULTRA_MODEL_IDS.has(normalized)) {
    return GPT_56_ULTRA_REASONING_EFFORTS;
  }
  if (normalized === "gpt-5.6-luna") {
    return GPT_56_MAX_REASONING_EFFORTS;
  }
  if (normalized === "gpt-5.5-pro" || normalized === "gpt-5.4-pro") {
    return GPT_5_PRO_REASONING_EFFORTS;
  }
  return undefined;
}

/** Resolve a turn effort from app-server metadata, with exact-name offline fallbacks. */
export function resolveCodexAppServerReasoningEffort(params: {
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"] | "ultra";
  modelId: string;
  supportedReasoningEfforts?: readonly string[];
}): CodexReasoningEffort | null {
  if (params.thinkLevel === "off" || params.thinkLevel === "adaptive") {
    return null;
  }
  const supportedReasoningEfforts =
    params.supportedReasoningEfforts ?? resolveFallbackReasoningEfforts(params.modelId);
  if (supportedReasoningEfforts) {
    return (
      resolveSupportedReasoningEffort({
        requested: params.thinkLevel,
        supportedReasoningEfforts,
      }) ?? null
    );
  }
  const normalizedModelId = params.modelId.trim().toLowerCase();
  if (params.thinkLevel === "minimal") {
    return MODERN_CODEX_MODEL_IDS.has(normalizedModelId) ? "low" : "minimal";
  }
  if (
    params.thinkLevel === "low" ||
    params.thinkLevel === "medium" ||
    params.thinkLevel === "high" ||
    params.thinkLevel === "xhigh"
  ) {
    return params.thinkLevel;
  }
  return params.thinkLevel === "max" && GPT_56_MAX_MODEL_IDS.has(normalizedModelId) ? "max" : null;
}
