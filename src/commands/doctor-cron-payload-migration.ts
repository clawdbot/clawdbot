import {
  normalizeOptionalLowercaseString,
  readStringValue as readString,
} from "../shared/string-coerce.js";

type UnknownRecord = Record<string, unknown>;

function toCanonicalOpenAIModelRef(value: unknown): string | undefined {
  const raw = readString(value);
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = trimmed.slice(0, slash).trim().toLowerCase();
  if (provider !== "openai-codex") {
    return undefined;
  }
  const model = trimmed.slice(slash + 1).trim();
  return model ? `openai/${model}` : undefined;
}

function normalizeChannel(value: string): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

export function hasLegacyOpenAICodexCronModelRef(payload: UnknownRecord): boolean {
  if (toCanonicalOpenAIModelRef(payload.model)) {
    return true;
  }
  const fallbacks = payload.fallbacks;
  return (
    Array.isArray(fallbacks) && fallbacks.some((fallback) => toCanonicalOpenAIModelRef(fallback))
  );
}

function migrateLegacyOpenAICodexModelRefs(payload: UnknownRecord): boolean {
  let mutated = false;

  const model = toCanonicalOpenAIModelRef(payload.model);
  if (model && payload.model !== model) {
    payload.model = model;
    mutated = true;
  }

  const fallbacks = payload.fallbacks;
  if (Array.isArray(fallbacks)) {
    const next = fallbacks.map((fallback) => toCanonicalOpenAIModelRef(fallback) ?? fallback);
    if (next.some((fallback, index) => fallback !== fallbacks[index])) {
      payload.fallbacks = next;
      mutated = true;
    }
  }

  return mutated;
}

export function migrateLegacyCronPayload(payload: UnknownRecord): boolean {
  let mutated = false;

  const channelValue = readString(payload.channel);
  const providerValue = readString(payload.provider);

  const nextChannel =
    typeof channelValue === "string" && channelValue.trim().length > 0
      ? normalizeChannel(channelValue)
      : typeof providerValue === "string" && providerValue.trim().length > 0
        ? normalizeChannel(providerValue)
        : "";

  if (nextChannel) {
    if (channelValue !== nextChannel) {
      payload.channel = nextChannel;
      mutated = true;
    }
  }

  if ("provider" in payload) {
    delete payload.provider;
    mutated = true;
  }

  if (migrateLegacyOpenAICodexModelRefs(payload)) {
    mutated = true;
  }

  return mutated;
}
