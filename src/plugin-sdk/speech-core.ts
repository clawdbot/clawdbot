export type {
  SpeechListVoicesRequest,
  SpeechProviderConfiguredContext,
  SpeechProviderId,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  SpeechTelephonySynthesisRequest,
  SpeechTelephonySynthesisResult,
  SpeechVoiceOption,
} from "../tts/provider-types.js";
export type { SpeechProviderPlugin } from "../plugins/types.js";

export type SpeechProviderConfig = Record<string, unknown>;
export type SpeechProviderOverrides = Record<string, unknown>;

export type SpeechDirectiveTokenParseContext = {
  key: string;
  value: string;
  policy: {
    allowVoice?: boolean;
    allowModelId?: boolean;
    allowVoiceSettings?: boolean;
    allowNormalization?: boolean;
    allowSeed?: boolean;
  };
  currentOverrides?: SpeechProviderOverrides;
};

export function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function normalizeApplyTextNormalization(
  value: unknown,
): "auto" | "on" | "off" | undefined {
  const normalized = trimToUndefined(value)?.toLowerCase();
  return normalized === "auto" || normalized === "on" || normalized === "off"
    ? normalized
    : undefined;
}

export function normalizeLanguageCode(value: unknown): string | undefined {
  return trimToUndefined(value)?.toLowerCase();
}

export function normalizeSeed(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  return parsed == null ? undefined : Math.trunc(parsed);
}

export function requireInRange(params: {
  value: number;
  min: number;
  max: number;
  label: string;
}): number {
  if (!Number.isFinite(params.value) || params.value < params.min || params.value > params.max) {
    throw new Error(`${params.label} must be between ${params.min} and ${params.max}`);
  }
  return params.value;
}
