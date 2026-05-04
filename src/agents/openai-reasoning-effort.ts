import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type OpenAIApiReasoningEffort = OpenAIReasoningEffort | (string & {});

type OpenAIReasoningModel = {
  provider?: unknown;
  id?: unknown;
  api?: unknown;
  baseUrl?: unknown;
  compat?: unknown;
};

const GPT_5_REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
const GPT_51_REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
const GPT_52_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
const GPT_CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const GPT_PRO_REASONING_EFFORTS = ["medium", "high", "xhigh"] as const;
const GPT_5_PRO_REASONING_EFFORTS = ["high"] as const;
const GPT_51_CODEX_MAX_REASONING_EFFORTS = ["none", "medium", "high", "xhigh"] as const;
const GPT_51_CODEX_MINI_REASONING_EFFORTS = ["medium"] as const;
const GENERIC_REASONING_EFFORTS = ["low", "medium", "high"] as const;

function normalizeModelId(id: string | null | undefined): string {
  return normalizeLowercaseStringOrEmpty(id ?? "").replace(/-\d{4}-\d{2}-\d{2}$/u, "");
}

export function isOpenAIGpt54MiniModel(model: OpenAIReasoningModel): boolean {
  const id = normalizeModelId(typeof model.id === "string" ? model.id : undefined);
  return /^gpt-5\.4-mini(?:-|$)/u.test(id);
}

export function normalizeOpenAIReasoningEffort(effort: string): string {
  return effort === "minimal" ? "minimal" : effort;
}

function readCompatReasoningEfforts(compat: unknown): OpenAIApiReasoningEffort[] | undefined {
  if (!compat || typeof compat !== "object") {
    return undefined;
  }
  const raw = (compat as { supportedReasoningEfforts?: unknown }).supportedReasoningEfforts;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const supported = [
    ...new Set(
      raw
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  return supported.length > 0 ? supported : undefined;
}

function isDisabledReasoningEffort(effort: string): boolean {
  return effort === "none" || effort === "off";
}

export function resolveOpenAISupportedReasoningEfforts(
  model: OpenAIReasoningModel,
): readonly OpenAIApiReasoningEffort[] {
  const compatEfforts = readCompatReasoningEfforts(model.compat);
  if (compatEfforts) {
    return compatEfforts;
  }

  const provider = normalizeLowercaseStringOrEmpty(
    typeof model.provider === "string" ? model.provider : "",
  );
  const id = normalizeModelId(typeof model.id === "string" ? model.id : undefined);
  if (id === "gpt-5.1-codex-mini") {
    return GPT_51_CODEX_MINI_REASONING_EFFORTS;
  }
  if (id === "gpt-5.1-codex-max") {
    return GPT_51_CODEX_MAX_REASONING_EFFORTS;
  }
  if (/^gpt-5(?:\.\d+)?-codex(?:-|$)/u.test(id) || provider === "openai-codex") {
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

export function supportsOpenAIReasoningEffort(
  model: OpenAIReasoningModel,
  effort: string,
): boolean {
  return resolveOpenAISupportedReasoningEfforts(model).includes(
    normalizeOpenAIReasoningEffort(effort) as OpenAIApiReasoningEffort,
  );
}

export function resolveOpenAIReasoningEffortForModel(params: {
  model: OpenAIReasoningModel;
  effort: string;
  fallbackMap?: Record<string, string>;
}): OpenAIApiReasoningEffort | undefined {
  const requested = normalizeOpenAIReasoningEffort(params.effort);
  const mapped = params.fallbackMap?.[requested] ?? requested;
  const normalized = normalizeOpenAIReasoningEffort(mapped);
  const supported = resolveOpenAISupportedReasoningEfforts(params.model);
  if (supported.includes(normalized as OpenAIApiReasoningEffort)) {
    return normalized as OpenAIApiReasoningEffort;
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
  return supported.find((effort) => effort !== "none");
}
