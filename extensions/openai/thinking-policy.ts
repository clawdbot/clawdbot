// Openai plugin module implements thinking policy behavior.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";

type OpenAIThinkingCompat = ProviderDefaultThinkingPolicyContext["compat"];

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
  "gpt-5.6",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.3-codex-spark",
] as const;

const OPENAI_UNIFIED_XHIGH_MODEL_IDS = [
  ...OPENAI_CODEX_XHIGH_MODEL_IDS,
  "gpt-5.4-mini",
  "gpt-5.4-nano",
] as const;

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase();
}

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

function buildAuthoritativeCodexLevels(
  efforts: readonly string[],
): ProviderThinkingProfile["levels"] {
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
  compat?: OpenAIThinkingCompat;
}): ProviderThinkingProfile {
  const modelId = normalizeModelId(params.modelId);
  const agentRuntime = normalizeModelId(params.agentRuntime ?? "");
  const isBare = modelId === "gpt-5.6";
  const isSol = modelId === "gpt-5.6-sol";
  const isTerra = modelId === "gpt-5.6-terra";
  const isLuna = modelId === "gpt-5.6-luna";
  const codexEfforts = params.compat?.supportedReasoningEfforts?.map(normalizeModelId);
  const hasDirectOpenAICompat = codexEfforts?.includes("none") === true;
  const authoritativeCodexEfforts = hasDirectOpenAICompat ? undefined : codexEfforts;
  const fallbackCodexMax = isSol || isTerra || isLuna;
  const codexSupportsMax = authoritativeCodexEfforts
    ? authoritativeCodexEfforts.includes("max")
    : fallbackCodexMax;
  const supportsMax =
    modelId.startsWith("gpt-5.6") && (agentRuntime !== "codex" || codexSupportsMax);
  const fallbackCodexUltra = isSol || isTerra;
  const codexSupportsUltra = authoritativeCodexEfforts
    ? authoritativeCodexEfforts.includes("ultra")
    : fallbackCodexUltra;
  // OpenClaw owns its logical Ultra orchestration. Native Codex owns its Ultra
  // catalog; direct API metadata must not erase the known native fallback.
  const supportsUltra =
    (isBare || isSol || isTerra || isLuna) &&
    (agentRuntime === "openclaw" ||
      agentRuntime === "auto" ||
      (agentRuntime === "codex" && codexSupportsUltra));
  const defaultLevel = isSol ? "low" : isTerra || isLuna ? "medium" : undefined;
  const fallbackLevels: ProviderThinkingProfile["levels"] = [
    ...OPENAI_THINKING_BASE_LEVELS,
    ...(matchesExactOrPrefix(params.modelId, params.xhighModelIds)
      ? [{ id: "xhigh" as const }]
      : []),
    ...(supportsMax ? [{ id: "max" as const }] : []),
    ...(supportsUltra ? [{ id: "ultra" as const }] : []),
  ];
  const levels =
    agentRuntime === "codex" && authoritativeCodexEfforts !== undefined
      ? buildAuthoritativeCodexLevels(authoritativeCodexEfforts)
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
): ProviderThinkingProfile {
  return buildOpenAIThinkingProfile({
    modelId,
    xhighModelIds: OPENAI_CODEX_XHIGH_MODEL_IDS,
    agentRuntime,
    compat,
  });
}

export function resolveUnifiedOpenAIThinkingProfile(
  modelId: string,
  agentRuntime?: string | null,
  compat?: OpenAIThinkingCompat,
): ProviderThinkingProfile {
  return buildOpenAIThinkingProfile({
    modelId,
    xhighModelIds: OPENAI_UNIFIED_XHIGH_MODEL_IDS,
    agentRuntime,
    compat,
  });
}
