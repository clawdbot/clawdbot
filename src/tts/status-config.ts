import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import type { TtsAutoMode, TtsConfig, TtsProvider } from "../config/types.tts.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { normalizeTtsAutoMode } from "./tts-auto-mode.js";
import { resolveEffectiveTtsConfig, type TtsConfigResolutionContext } from "./tts-config.js";

const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;
const DEFAULT_OPENAI_TTS_BASE_URL = "https://api.openai.com/v1";
const MAX_STATUS_DETAIL_LENGTH = 96;

type TtsUserPrefs = {
  tts?: {
    auto?: TtsAutoMode;
    enabled?: boolean;
    provider?: TtsProvider;
    persona?: string | null;
    maxLength?: number;
    summarize?: boolean;
  };
};

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

function resolveConfiguredTtsAutoMode(raw: TtsConfig): TtsAutoMode {
  return normalizeTtsAutoMode(raw.auto) ?? (raw.enabled ? "always" : "off");
}

function normalizeConfiguredSpeechProviderId(
  providerId: string | undefined,
): TtsProvider | undefined {
  const normalized = normalizeOptionalLowercaseString(providerId);
  if (!normalized) {
    return undefined;
  }
  return normalized === "edge" ? "microsoft" : normalized;
}

function normalizeTtsPersonaId(personaId: string | null | undefined): string | undefined {
  return normalizeOptionalLowercaseString(personaId ?? undefined);
}

function resolvePersonaPreferredProvider(
  raw: TtsConfig,
  personaId: string | undefined,
): TtsProvider | undefined {
  if (!personaId || !raw.personas) {
    return undefined;
  }
  for (const [id, persona] of Object.entries(raw.personas)) {
    if (normalizeTtsPersonaId(id) !== personaId) {
      continue;
    }
    const provider = normalizeConfiguredSpeechProviderId(persona.provider) ?? persona.provider;
    return normalizeOptionalString(provider);
  }
  return undefined;
}

function resolveTtsPrefsPathValue(prefsPath: string | undefined): string {
  const configuredPath = normalizeOptionalString(prefsPath);
  if (configuredPath) {
    return resolveUserPath(configuredPath);
  }
  const envPath = normalizeOptionalString(process.env.OPENCLAW_TTS_PREFS);
  if (envPath) {
    return resolveUserPath(envPath);
  }
  return path.join(resolveConfigDir(process.env), "settings", "tts.json");
}

function readPrefs(prefsPath: string): TtsUserPrefs {
  try {
    if (!fs.existsSync(prefsPath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(prefsPath, "utf8")) as TtsUserPrefs;
  } catch {
    return {};
  }
}

function resolveTtsAutoModeFromPrefs(prefs: TtsUserPrefs): TtsAutoMode | undefined {
  const auto = normalizeTtsAutoMode(prefs.tts?.auto);
  if (auto) {
    return auto;
  }
  if (typeof prefs.tts?.enabled === "boolean") {
    return prefs.tts.enabled ? "always" : "off";
  }
  return undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
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
  const voice = firstStatusDetail(record, ["voice", "voiceId", "voiceName"]);
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
  const context: TtsConfigResolutionContext = {
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  };
  const raw: TtsConfig = resolveEffectiveTtsConfig(params.cfg, context);
  const prefsPath = resolveTtsPrefsPathValue(raw.prefsPath);
  const prefs = readPrefs(prefsPath);
  const autoMode =
    normalizeTtsAutoMode(params.sessionAuto) ??
    resolveTtsAutoModeFromPrefs(prefs) ??
    resolveConfiguredTtsAutoMode(raw);

  if (autoMode === "off") {
    return null;
  }

  const persona =
    prefs.tts && Object.prototype.hasOwnProperty.call(prefs.tts, "persona")
      ? normalizeTtsPersonaId(prefs.tts.persona)
      : normalizeTtsPersonaId(raw.persona);
  const provider =
    normalizeConfiguredSpeechProviderId(prefs.tts?.provider) ??
    resolvePersonaPreferredProvider(raw, persona) ??
    normalizeConfiguredSpeechProviderId(raw.provider) ??
    "auto";

  return {
    autoMode,
    provider,
    ...resolveStatusProviderDetails(raw, provider),
    ...(persona ? { persona } : {}),
    maxLength: prefs.tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH,
    summarize: prefs.tts?.summarize ?? DEFAULT_TTS_SUMMARIZE,
  };
}
