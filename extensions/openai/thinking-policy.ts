// Openai plugin module implements thinking policy behavior.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty as normalizeModelId } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  OPENAI_GPT_53_CODEX_SPARK_MODEL_ID,
  OPENAI_GPT_54_MINI_MODEL_ID,
  OPENAI_GPT_54_MODEL_ID,
  OPENAI_GPT_54_NANO_MODEL_ID,
  OPENAI_GPT_54_PRO_MODEL_ID,
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_55_PRO_MODEL_ID,
  OPENAI_GPT_56_MODEL_ID,
  resolveOpenAICodexReasoningEfforts,
} from "./model-route-contract.js";

type OpenAIThinkingCompat = ProviderDefaultThinkingPolicyContext["compat"];
type OpenAIThinkingApi = ProviderDefaultThinkingPolicyContext["api"];

const OPENAI_THINKING_BASE_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
] as const satisfies ProviderThinkingProfile["levels"];

const OPENAI_THINKING_LEVEL_ORDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
type OpenAIThinkingLevelId = (typeof OPENAI_THINKING_LEVEL_ORDER)[number];

const OPENAI_CODEX_XHIGH_MODEL_IDS = [
  OPENAI_GPT_56_MODEL_ID,
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_55_PRO_MODEL_ID,
  OPENAI_GPT_54_MODEL_ID,
  OPENAI_GPT_54_PRO_MODEL_ID,
  OPENAI_GPT_53_CODEX_SPARK_MODEL_ID,
] as const;

const OPENAI_UNIFIED_XHIGH_MODEL_IDS = [
  ...OPENAI_CODEX_XHIGH_MODEL_IDS,
  OPENAI_GPT_54_MINI_MODEL_ID,
  OPENAI_GPT_54_NANO_MODEL_ID,
] as const;

function matchesExactOrPrefix(id: string, values: readonly string[]): boolean {
  const normalizedId = normalizeModelId(id);
  return values.some((value) => {
    const normalizedValue = normalizeModelId(value);
    return normalizedId === normalizedValue || normalizedId.startsWith(normalizedValue);
  });
}

function normalizeCodexReasoningEffort(value: string): OpenAIThinkingLevelId | undefined {
  const normalized = normalizeModelId(value);
  if (normalized === "none") {
    return "off";
  }
  return OPENAI_THINKING_LEVEL_ORDER.find((level) => level === normalized);
}

function buildCodexLevels(efforts: readonly string[]): ProviderThinkingProfile["levels"] {
  // Omitting an effort remains a valid Codex choice even when model/list has
  // no reasoning presets. Every other picker stop must come from that list.
  const supported = new Set<OpenAIThinkingLevelId>(["off"]);
  for (const effort of efforts) {
    const level = normalizeCodexReasoningEffort(effort);
    if (level) {
      supported.add(level);
    }
  }
  return OPENAI_THINKING_LEVEL_ORDER.filter((level) => supported.has(level)).map((id) => ({ id }));
}

function buildOpenAIThinkingProfile(params: {
  modelId: string;
  xhighModelIds: readonly string[];
  agentRuntime?: string | null;
  api?: OpenAIThinkingApi;
  compat?: OpenAIThinkingCompat;
}): ProviderThinkingProfile {
  const modelId = normalizeModelId(params.modelId);
  const agentRuntime = normalizeModelId(params.agentRuntime ?? "");
  const codexEfforts = params.compat?.supportedReasoningEfforts?.map(normalizeModelId);
  const resolvedCodexEfforts =
    params.api === undefined || params.api === "openai-chatgpt-responses"
      ? resolveOpenAICodexReasoningEfforts(modelId, codexEfforts)
      : undefined;
  const knownCodexEfforts = resolveOpenAICodexReasoningEfforts(modelId, undefined);
  const isGpt56Variant = knownCodexEfforts !== undefined;
  const codexSupportsMax = (resolvedCodexEfforts ?? knownCodexEfforts)?.includes("max");
  const supportsMax =
    modelId.startsWith("gpt-5.6") && (agentRuntime !== "codex" || codexSupportsMax);
  const codexSupportsUltra = (resolvedCodexEfforts ?? knownCodexEfforts)?.includes("ultra");
  // OpenClaw owns its logical Ultra orchestration. Native Codex capabilities
  // come from native discovery or the selected ChatGPT route's catalog metadata.
  const supportsUltra =
    (modelId === OPENAI_GPT_56_MODEL_ID || isGpt56Variant) &&
    (agentRuntime === "openclaw" ||
      agentRuntime === "auto" ||
      (agentRuntime === "codex" && codexSupportsUltra));
  const nativeCodexNeedsAccountEffortValidation =
    agentRuntime === "codex" &&
    params.compat?.supportedReasoningEfforts === undefined &&
    (params.api === undefined || params.api === "openai-chatgpt-responses") &&
    !matchesExactOrPrefix(params.modelId, params.xhighModelIds) &&
    !modelId.startsWith("gpt-5.6");
  const defaultLevel = isGpt56Variant ? "medium" : undefined;
  const fallbackLevels: ProviderThinkingProfile["levels"] = [
    ...OPENAI_THINKING_BASE_LEVELS,
    ...(matchesExactOrPrefix(params.modelId, params.xhighModelIds)
      ? [{ id: "xhigh" as const }]
      : []),
    ...(supportsMax ? [{ id: "max" as const }] : []),
    ...(supportsUltra ? [{ id: "ultra" as const }] : []),
    ...(nativeCodexNeedsAccountEffortValidation
      ? [{ id: "xhigh" as const }, { id: "max" as const }]
      : []),
  ];
  const levels =
    agentRuntime === "codex" && resolvedCodexEfforts !== undefined
      ? buildCodexLevels(resolvedCodexEfforts)
      : fallbackLevels;
  const supportedDefault = defaultLevel && levels.some((level) => level.id === defaultLevel);
  return {
    levels,
    ...(supportedDefault ? { defaultLevel } : {}),
  };
}

export function resolveOpenAICodexThinkingProfile(
  modelId: string,
  agentRuntime?: string | null,
  compat?: OpenAIThinkingCompat,
  api?: OpenAIThinkingApi,
): ProviderThinkingProfile {
  return buildOpenAIThinkingProfile({
    modelId,
    xhighModelIds: OPENAI_CODEX_XHIGH_MODEL_IDS,
    agentRuntime,
    api,
    compat,
  });
}

export function resolveUnifiedOpenAIThinkingProfile(
  modelId: string,
  agentRuntime?: string | null,
  compat?: OpenAIThinkingCompat,
  api?: OpenAIThinkingApi,
): ProviderThinkingProfile {
  return buildOpenAIThinkingProfile({
    modelId,
    xhighModelIds: OPENAI_UNIFIED_XHIGH_MODEL_IDS,
    agentRuntime,
    api,
    compat,
  });
}
