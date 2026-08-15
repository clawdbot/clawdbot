// TTS status config helpers resolve status output paths for speech generation.
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.js";
import type { TtsAutoMode, TtsConfig, TtsProvider } from "../config/types.tts.js";
import { resolveTtsSettingsSnapshot } from "./tts-settings.js";

const DEFAULT_OPENAI_TTS_BASE_URL = "https://api.openai.com/v1";
const MAX_STATUS_DETAIL_LENGTH = 96;

type TtsStatusSnapshot = {
  autoMode: TtsAutoMode;
  provider: TtsProvider;
  displayName?: string;
  model?: string;
  voice?: string;
  persona?: string;
  baseUrl?: string;
  customBaseUrl?: boolean;
  maxLength: number;
  summarize: boolean;
};

function normalizeStatusDetail(
  value: unknown,
  maxLength = MAX_STATUS_DETAIL_LENGTH,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength
    ? `${truncateUtf16Safe(normalized, maxLength - 3)}...`
    : normalized;
}

function sanitizeBaseUrlForStatus(value: unknown): string | undefined {
  const raw = normalizeStatusDetail(value, 180);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const sanitized = parsed.toString().replace(/\/+$/, "");
    return normalizeStatusDetail(sanitized, 120);
  } catch {
    return "[invalid-url]";
  }
}

function isCustomOpenAiTtsBaseUrl(baseUrl: string | undefined): boolean {
  return baseUrl ? baseUrl.replace(/\/+$/, "") !== DEFAULT_OPENAI_TTS_BASE_URL : false;
}

function firstStatusDetail(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = normalizeStatusDetail(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveProviderConfigRecord(
  raw: TtsConfig,
  provider: TtsProvider,
): Record<string, unknown> | undefined {
  const rawRecord: Record<string, unknown> = isObjectRecord(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const providers: Record<string, unknown> = isObjectRecord(raw.providers) ? raw.providers : {};
  if (provider === "microsoft") {
    return {
      ...(isObjectRecord(rawRecord.edge) ? rawRecord.edge : {}),
      ...(isObjectRecord(rawRecord.microsoft) ? rawRecord.microsoft : {}),
      ...(isObjectRecord(providers.edge) ? providers.edge : {}),
      ...(isObjectRecord(providers.microsoft) ? providers.microsoft : {}),
    };
  }
  const direct = rawRecord[provider];
  const providerScoped = providers[provider];
  if (isObjectRecord(providerScoped)) {
    return providerScoped;
  }
  if (isObjectRecord(direct)) {
    return direct;
  }
  return rawRecord;
}

function resolveStatusProviderDetails(raw: TtsConfig, provider: TtsProvider) {
  if (provider === "auto") {
    return {};
  }
  const record = resolveProviderConfigRecord(raw, provider);
  const sanitizedBaseUrl = sanitizeBaseUrlForStatus(record?.baseUrl);
  const customBaseUrl = provider === "openai" && isCustomOpenAiTtsBaseUrl(sanitizedBaseUrl);
  const details: Partial<TtsStatusSnapshot> = {};
  const displayName = firstStatusDetail(record, ["displayName"]);
  if (displayName) {
    details.displayName = displayName;
  }
  const model = firstStatusDetail(record, ["model", "modelId"]);
  if (model) {
    details.model = model;
  }
  const voice = firstStatusDetail(record, [
    "speakerVoice",
    "speakerVoiceId",
    "voice",
    "voiceId",
    "voiceName",
  ]);
  if (voice) {
    details.voice = voice;
  }
  if (sanitizedBaseUrl && (provider !== "openai" || customBaseUrl)) {
    details.baseUrl = sanitizedBaseUrl;
    details.customBaseUrl = customBaseUrl;
  }
  return details;
}

export function resolveStatusTtsSnapshot(params: {
  cfg: OpenClawConfig;
  sessionAuto?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}): TtsStatusSnapshot | null {
  const settings = resolveTtsSettingsSnapshot(params);
  if (settings.autoMode === "off") {
    return null;
  }
  const provider = settings.preferredProvider ?? "auto";

  return {
    autoMode: settings.autoMode,
    provider,
    ...resolveStatusProviderDetails(settings.config.rawConfig ?? {}, provider),
    ...(settings.personaId ? { persona: settings.personaId } : {}),
    maxLength: settings.maxLength,
    summarize: settings.summarize,
  };
}
