/**
 * OpenAI-compatible reasoning-effort normalization. Different GPT families
 * expose different accepted effort enums, so callers map requested values here
 * before constructing provider payloads.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";

export type OpenAIReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type OpenAIApiReasoningEffort = OpenAIReasoningEffort | (string & {});

type OpenAIReasoningModel = {
  provider?: unknown;
  id?: unknown;
  name?: unknown;
  api?: unknown;
  baseUrl?: unknown;
  compat?: unknown;
  thinkingLevelMap?: unknown;
};

const GPT_5_REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
const GPT_51_REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
const GPT_52_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
const GPT_56_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const GPT_CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const GPT_PRO_REASONING_EFFORTS = ["medium", "high", "xhigh"] as const;
const GPT_5_PRO_REASONING_EFFORTS = ["high"] as const;
const GPT_51_CODEX_MAX_REASONING_EFFORTS = ["none", "medium", "high", "xhigh"] as const;
const GPT_51_CODEX_MINI_REASONING_EFFORTS = ["medium"] as const;
const GENERIC_REASONING_EFFORTS = ["low", "medium", "high"] as const;
const CANONICAL_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "off",
]);

function normalizeModelId(id: string | null | undefined): string {
  return normalizeLowercaseStringOrEmpty(id ?? "").replace(/-\d{4}-\d{2}-\d{2}$/u, "");
}

/** Return whether a model is the GPT-5.4 mini family. */
export function isOpenAIGpt54MiniModel(model: OpenAIReasoningModel): boolean {
  const id = normalizeModelId(typeof model.id === "string" ? model.id : undefined);
  return /^gpt-5\.4-mini(?:-|$)/u.test(id);
}

/** Return whether a model is the GPT-5.5 family. */
export function isOpenAIGpt55Model(model: OpenAIReasoningModel): boolean {
  const id = normalizeModelId(typeof model.id === "string" ? model.id : undefined);
  const name = normalizeModelId(typeof model.name === "string" ? model.name : undefined);
  return /^gpt-5\.5(?:-|$)/u.test(id) || /^gpt-5\.5(?:\s|\(|-|$)/u.test(name);
}

/** Return whether a model is the GPT-5.6 family. */
export function isOpenAIGpt56Model(model: OpenAIReasoningModel): boolean {
  const id = normalizeModelId(typeof model.id === "string" ? model.id : undefined);
  const name = normalizeModelId(typeof model.name === "string" ? model.name : undefined);
  return /^gpt-5\.6(?:-|$)/u.test(id) || /^gpt-5\.6(?:\s|\(|-|$)/u.test(name);
}

/** Normalize user-facing reasoning effort names to API effort names. */
export function normalizeOpenAIReasoningEffort(effort: string): string {
  const trimmed = effort.trim();
  const folded = trimmed.toLowerCase();
  // Only fold canonical names; provider-native values can be case-sensitive.
  return CANONICAL_REASONING_EFFORTS.has(folded) ? folded : trimmed;
}

function readCompatReasoningEfforts(compat: unknown): OpenAIApiReasoningEffort[] | undefined {
  if (!compat || typeof compat !== "object") {
    return undefined;
  }
  if ((compat as { supportsReasoningEffort?: unknown }).supportsReasoningEffort === false) {
    return [];
  }
  const raw = (compat as { supportedReasoningEfforts?: unknown }).supportedReasoningEfforts;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const supported = uniqueStrings(
    normalizeStringEntries(raw.filter((value) => typeof value === "string")),
  );
  return supported.length > 0 ? supported : undefined;
}

function isDisabledReasoningEffort(effort: string): boolean {
  return effort === "none" || effort === "off";
}

function readFallbackMapValue(map: unknown, requested: string): string | null | undefined {
  if (!isRecord(map)) {
    return undefined;
  }
  const direct = map[requested];
  if (typeof direct === "string" || direct === null) {
    return direct;
  }
  if (!CANONICAL_REASONING_EFFORTS.has(requested)) {
    return undefined;
  }
  return Object.entries(map).find(
    ([effort, value]) =>
      (typeof value === "string" || value === null) &&
      normalizeOpenAIReasoningEffort(effort) === requested,
  )?.[1] as string | null | undefined;
}

/** Resolve the reasoning efforts accepted by a specific OpenAI-compatible model. */
export function resolveOpenAISupportedReasoningEfforts(
  model: OpenAIReasoningModel,
): readonly OpenAIApiReasoningEffort[] {
  const compatEfforts = readCompatReasoningEfforts(model.compat);
  if (compatEfforts) {
    return compatEfforts;
  }

  const id = normalizeModelId(typeof model.id === "string" ? model.id : undefined);
  if (/^gpt-5\.6(?:-|$)/u.test(id)) {
    return GPT_56_REASONING_EFFORTS;
  }
  if (id === "gpt-5.1-codex-mini") {
    return GPT_51_CODEX_MINI_REASONING_EFFORTS;
  }
  if (id === "gpt-5.1-codex-max") {
    return GPT_51_CODEX_MAX_REASONING_EFFORTS;
  }
  if (/^gpt-5(?:\.\d+)?-codex(?:-|$)/u.test(id)) {
    return GPT_CODEX_REASONING_EFFORTS;
  }
  if (id === "gpt-5-pro") {
    return GPT_5_PRO_REASONING_EFFORTS;
  }
  if (/^gpt-5\.[2-9](?:\.\d+)?-pro(?:-|$)/u.test(id)) {
    return GPT_PRO_REASONING_EFFORTS;
  }
  if (/^gpt-5\.[2-9](?:\.\d+)?(?:-|$)/u.test(id)) {
    return GPT_52_REASONING_EFFORTS;
  }
  if (/^gpt-5\.1(?:-|$)/u.test(id)) {
    return GPT_51_REASONING_EFFORTS;
  }
  if (/^gpt-5(?:-|$)/u.test(id)) {
    return GPT_5_REASONING_EFFORTS;
  }
  return GENERIC_REASONING_EFFORTS;
}

/**
 * Return whether a model accepts the temperature parameter. The GPT-5.6
 * family rejects it with a 400; catalog compat can override per model.
 */
export function supportsOpenAITemperature(model: OpenAIReasoningModel): boolean {
  const compat = model.compat;
  if (compat && typeof compat === "object") {
    const declared = (compat as { supportsTemperature?: unknown }).supportsTemperature;
    if (typeof declared === "boolean") {
      return declared;
    }
  }
  const id = normalizeModelId(typeof model.id === "string" ? model.id : undefined);
  return !/^gpt-5\.6(?:-|$)/u.test(id);
}

/** Return whether a model accepts a requested reasoning effort. */
export function supportsOpenAIReasoningEffort(
  model: OpenAIReasoningModel,
  effort: string,
): boolean {
  return resolveOpenAISupportedReasoningEfforts(model).includes(
    normalizeOpenAIReasoningEffort(effort) as OpenAIApiReasoningEffort,
  );
}

/** Resolve a requested reasoning effort to the closest value supported by the model. */
export function resolveOpenAIReasoningEffortForModel(params: {
  model: OpenAIReasoningModel;
  effort: string;
  fallbackMap?: Partial<Record<string, string | null>>;
}): OpenAIApiReasoningEffort | undefined {
  const requested = normalizeOpenAIReasoningEffort(params.effort);
  // Config preserves map-key casing, so only canonical keys get a folded lookup.
  const mapped = readFallbackMapValue(params.fallbackMap, requested);
  // A null map entry marks the level as explicitly unsupported; never fall back
  // to the generic requested value for it.
  if (mapped === null) {
    return undefined;
  }
  // Explicit maps are the canonical provider-native contract; preserve their exact casing.
  const normalized = mapped === undefined ? requested : mapped.trim();
  if (mapped !== undefined) {
    return normalized ? (normalized as OpenAIApiReasoningEffort) : undefined;
  }
  const supported = resolveOpenAISupportedReasoningEfforts(params.model);
  if (supported.includes(normalized as OpenAIApiReasoningEffort)) {
    return normalized as OpenAIApiReasoningEffort;
  }
  if (requested === "off" && supported.includes("none")) {
    return "none";
  }
  if (isDisabledReasoningEffort(requested) || isDisabledReasoningEffort(normalized)) {
    return undefined;
  }
  if (requested === "minimal" && supported.includes("low")) {
    return "low";
  }
  if ((requested === "minimal" || requested === "low") && supported.includes("medium")) {
    return "medium";
  }
  if (requested === "xhigh" && supported.includes("high")) {
    return "high";
  }
  if (requested === "max" && supported.includes("xhigh")) {
    return "xhigh";
  }
  return supported.find(
    (effort) => !isDisabledReasoningEffort(normalizeOpenAIReasoningEffort(effort)),
  );
}

/** Resolve Responses reasoning through the public compat map while preserving null guards. */
export function resolveOpenAIResponsesReasoningEffortForModel(params: {
  model: OpenAIReasoningModel;
  effort: string;
}): OpenAIApiReasoningEffort | undefined {
  const requested = normalizeOpenAIReasoningEffort(params.effort);
  const thinkingMap = params.model.thinkingLevelMap;
  const thinkingMapped = readFallbackMapValue(thinkingMap, requested);
  if (thinkingMapped === null) {
    return undefined;
  }
  const compatMap = isRecord(params.model.compat)
    ? (params.model.compat.reasoningEffortMap as unknown)
    : undefined;
  const compatMapped = readFallbackMapValue(compatMap, requested);
  if (compatMapped === null) {
    return undefined;
  }
  const effective = resolveOpenAIReasoningEffortForModel({
    model: params.model,
    effort: requested,
  });
  if (!effective) {
    const requestedMapped = compatMapped ?? thinkingMapped;
    if (requestedMapped === undefined) {
      return undefined;
    }
    const normalized = requestedMapped.trim();
    return normalized ? (normalized as OpenAIApiReasoningEffort) : undefined;
  }
  const normalizedEffective = normalizeOpenAIReasoningEffort(effective);
  const effectiveThinkingMapped = readFallbackMapValue(thinkingMap, normalizedEffective);
  if (effectiveThinkingMapped === null) {
    return undefined;
  }
  const effectiveCompatMapped = readFallbackMapValue(compatMap, normalizedEffective);
  if (effectiveCompatMapped === null) {
    return undefined;
  }
  const mapped = effectiveCompatMapped ?? effectiveThinkingMapped ?? compatMapped ?? thinkingMapped;
  if (mapped === undefined) {
    return effective;
  }
  const normalized = mapped.trim();
  return normalized ? (normalized as OpenAIApiReasoningEffort) : undefined;
}
