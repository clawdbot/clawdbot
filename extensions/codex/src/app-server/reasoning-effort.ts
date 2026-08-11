import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";

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

const LEGACY_PRO_REASONING_EFFORTS = ["medium", "high", "xhigh"] as const;
const LEGACY_PRO_MODEL_ID_RE = /^gpt-5\.[45]-pro$/u;
const MODERN_GPT_5_MODEL_ID_RE = /^gpt-5\.(?:[3-9]|[1-9]\d)(?:$|-)/u;

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

/** Resolve a turn effort from the selected model's provider-owned metadata. */
export function resolveCodexAppServerReasoningEffort(params: {
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"] | "ultra";
  modelId: string;
  supportedReasoningEfforts?: readonly string[];
}): CodexReasoningEffort | null {
  if (params.thinkLevel === "off" || params.thinkLevel === "adaptive") {
    return null;
  }
  if (params.supportedReasoningEfforts) {
    return (
      resolveSupportedReasoningEffort({
        requested: params.thinkLevel,
        supportedReasoningEfforts: params.supportedReasoningEfforts,
      }) ?? null
    );
  }
  const modelId = params.modelId.trim().toLowerCase();
  // Preserve compatibility for deprecated Pro catalog rows that predate effort
  // metadata. New model capabilities must come from the provider catalog.
  if (LEGACY_PRO_MODEL_ID_RE.test(modelId)) {
    return (
      resolveSupportedReasoningEffort({
        requested: params.thinkLevel,
        supportedReasoningEfforts: LEGACY_PRO_REASONING_EFFORTS,
      }) ?? null
    );
  }
  if (params.thinkLevel === "minimal" && MODERN_GPT_5_MODEL_ID_RE.test(modelId)) {
    return "low";
  }
  if (
    params.thinkLevel === "minimal" ||
    params.thinkLevel === "low" ||
    params.thinkLevel === "medium" ||
    params.thinkLevel === "high" ||
    params.thinkLevel === "xhigh"
  ) {
    return params.thinkLevel;
  }
  return null;
}
