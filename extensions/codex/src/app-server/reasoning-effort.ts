import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";

const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type CodexEnabledReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
type CodexReasoningEffort = CodexEnabledReasoningEffort | "none" | "ultra";

const LEGACY_PRO_REASONING_EFFORTS = ["medium", "high", "xhigh"] as const;
const LEGACY_PRO_MODEL_ID_RE = /^gpt-5\.[45]-pro$/u;
const MODERN_GPT_5_MODEL_ID_RE = /^gpt-5\.(?:[3-9]|[1-9]\d)(?:$|-)/u;

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
  requested: CodexEnabledReasoningEffort;
  supportedReasoningEfforts: readonly string[];
}): CodexEnabledReasoningEffort | undefined {
  const declared = new Set(
    params.supportedReasoningEfforts.map((effort) => effort.trim().toLowerCase()),
  );
  const supported = CODEX_REASONING_EFFORTS.filter((effort) => declared.has(effort));
  if (supported.includes(params.requested)) {
    return params.requested;
  }
  const requestedRank = CODEX_REASONING_EFFORTS.indexOf(params.requested);
  return (
    supported.find((effort) => CODEX_REASONING_EFFORTS.indexOf(effort) >= requestedRank) ??
    supported.at(-1)
  );
}

export function resolveCodexAppServerReasoningEffort(params: {
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"];
  modelId: string;
  supportedReasoningEfforts?: readonly string[];
}): CodexReasoningEffort | null {
  // Ultra is a runtime mode, not an API effort tier. Codex owns its inference
  // budget and proactive delegation; route metadata must not erase the runtime mode.
  if (params.thinkLevel === "ultra") {
    return "ultra";
  }
  if (params.thinkLevel === "off") {
    return params.supportedReasoningEfforts?.includes("none") ? "none" : null;
  }
  if (params.thinkLevel === "adaptive") {
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
