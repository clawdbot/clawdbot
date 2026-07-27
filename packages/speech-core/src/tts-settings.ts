// Lightweight TTS settings resolution shared by agent prompts, status, and speech runtime.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  OpenClawConfig,
  ResolvedTtsPersona,
  TtsAutoMode,
  TtsConfig,
  TtsModelOverrideConfig,
  TtsProvider,
} from "openclaw/plugin-sdk/config-contracts";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { SpeechProviderConfig } from "openclaw/plugin-sdk/speech-core";
import {
  normalizeSpeechProviderId,
  normalizeTtsAutoMode,
  resolveEffectiveTtsConfig,
  type ResolvedTtsConfig,
  type ResolvedTtsModelOverrides,
  type TtsConfigResolutionContext,
} from "openclaw/plugin-sdk/speech-settings";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveConfigDir, resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { withSpeakerSelectionCompat } from "../speaker.js";

export type { ResolvedTtsConfig, ResolvedTtsModelOverrides };

export const DEFAULT_TTS_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;
const DEFAULT_MAX_TEXT_LENGTH = 4096;
let machinePrefsPathResolver: () => string | undefined = () => undefined;

export function setTtsMachinePrefsPathResolver(resolver?: () => string | undefined): void {
  machinePrefsPathResolver = resolver ?? (() => undefined);
}

export type TtsUserPrefs = {
  tts?: {
    auto?: TtsAutoMode;
    enabled?: boolean;
    provider?: TtsProvider;
    persona?: string | null;
    maxLength?: number;
    summarize?: boolean;
  };
};

function resolveConfiguredTtsAutoMode(raw: TtsConfig): TtsAutoMode {
  return normalizeTtsAutoMode(raw.auto) ?? (raw.enabled ? "always" : "off");
}

export function normalizeConfiguredSpeechProviderId(
  providerId: string | undefined,
): TtsProvider | undefined {
  const normalized = normalizeSpeechProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return normalized === "edge" ? "microsoft" : normalized;
}

export function normalizeTtsPersonaId(personaId: string | null | undefined): string | undefined {
  return normalizeOptionalLowercaseString(personaId ?? undefined);
}

function resolveTtsPrefsPathValue(prefsPath: string | undefined): string {
  // Scoped agent paths must win over the migrated machine-wide default.
  if (prefsPath?.trim()) {
    return resolveUserPath(prefsPath.trim());
  }
  const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
  if (envPath) {
    return resolveUserPath(envPath);
  }
  const machinePath = machinePrefsPathResolver()?.trim();
  if (machinePath) {
    return resolveUserPath(machinePath);
  }
  return path.join(resolveConfigDir(process.env), "settings", "tts.json");
}

export function resolveModelOverridePolicy(
  overrides: TtsModelOverrideConfig | undefined,
): ResolvedTtsModelOverrides {
  const enabled = overrides?.enabled ?? true;
  if (!enabled) {
    return {
      enabled: false,
      allowText: false,
      allowProvider: false,
      allowVoice: false,
      allowModelId: false,
      allowVoiceSettings: false,
      allowNormalization: false,
      allowSeed: false,
    };
  }
  const allow = (value: boolean | undefined, defaultValue = true) => value ?? defaultValue;
  return {
    enabled: true,
    allowText: allow(overrides?.allowText),
    allowProvider: allow(overrides?.allowProvider, false),
    allowVoice: allow(overrides?.allowVoice),
    allowModelId: allow(overrides?.allowModelId),
    allowVoiceSettings: allow(overrides?.allowVoiceSettings),
    allowNormalization: allow(overrides?.allowNormalization),
    allowSeed: allow(overrides?.allowSeed),
  };
}

export function resolveTtsRuntimeConfig(cfg: OpenClawConfig): OpenClawConfig {
  return (
    selectApplicableRuntimeConfig({
      inputConfig: cfg,
      runtimeConfig: getRuntimeConfigSnapshot(),
      runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
    }) ?? cfg
  );
}

export function asProviderConfig(value: unknown): SpeechProviderConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? withSpeakerSelectionCompat(value as SpeechProviderConfig)
    : {};
}

export function asProviderConfigMap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function hasOwnProperty(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function normalizeProviderConfigMap(
  value: unknown,
): Record<string, SpeechProviderConfig> | undefined {
  const rawMap = asProviderConfigMap(value);
  if (Object.keys(rawMap).length === 0) {
    return undefined;
  }
  const next: Record<string, SpeechProviderConfig> = {};
  for (const [providerId, providerConfig] of Object.entries(rawMap)) {
    const normalized = normalizeConfiguredSpeechProviderId(providerId) ?? providerId;
    next[normalized] = asProviderConfig(providerConfig);
  }
  return next;
}

function collectTtsPersonas(raw: TtsConfig): Record<string, ResolvedTtsPersona> {
  const rawPersonas = asProviderConfigMap(raw.personas);
  const personas: Record<string, ResolvedTtsPersona> = {};
  for (const [id, value] of Object.entries(rawPersonas)) {
    const normalizedId = normalizeTtsPersonaId(id);
    if (!normalizedId || typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const persona = value as Omit<ResolvedTtsPersona, "id">;
    personas[normalizedId] = {
      ...persona,
      id: normalizedId,
      provider: normalizeConfiguredSpeechProviderId(persona.provider) ?? persona.provider,
      providers: normalizeProviderConfigMap(persona.providers),
    };
  }
  return personas;
}

function collectDirectProviderConfigEntries(raw: TtsConfig): Record<string, SpeechProviderConfig> {
  const entries: Record<string, SpeechProviderConfig> = {};
  const rawProviders = asProviderConfigMap(raw.providers);
  for (const [providerId, value] of Object.entries(rawProviders)) {
    const normalized = normalizeConfiguredSpeechProviderId(providerId) ?? providerId;
    entries[normalized] = asProviderConfig(value);
  }
  const reservedKeys = new Set([
    "auto",
    "enabled",
    "maxTextLength",
    "mode",
    "modelOverrides",
    "persona",
    "personas",
    "prefsPath",
    "provider",
    "providers",
    "summaryModel",
    "timeoutMs",
  ]);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (reservedKeys.has(key)) {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const normalized = normalizeConfiguredSpeechProviderId(key) ?? key;
    entries[normalized] ??= asProviderConfig(value);
  }
  return entries;
}

export function resolveTtsConfig(
  cfgInput: OpenClawConfig,
  contextOrAgentId?: string | TtsConfigResolutionContext,
): ResolvedTtsConfig {
  const cfg = resolveTtsRuntimeConfig(cfgInput);
  const raw: TtsConfig = resolveEffectiveTtsConfig(cfg, contextOrAgentId);
  const providerSource = raw.provider ? "config" : "default";
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  const timeoutMsSource = raw.timeoutMs === undefined ? "default" : "config";
  return {
    auto: resolveConfiguredTtsAutoMode(raw),
    mode: raw.mode ?? "final",
    provider:
      normalizeConfiguredSpeechProviderId(raw.provider) ??
      (providerSource === "config" ? (normalizeOptionalLowercaseString(raw.provider) ?? "") : ""),
    providerSource,
    persona: normalizeTtsPersonaId(raw.persona),
    personas: collectTtsPersonas(raw),
    summaryModel: normalizeOptionalString(raw.summaryModel),
    modelOverrides: resolveModelOverridePolicy(raw.modelOverrides),
    providerConfigs: collectDirectProviderConfigEntries(raw),
    prefsPath: (raw as TtsConfig & { prefsPath?: string }).prefsPath,
    maxTextLength: raw.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    timeoutMs,
    timeoutMsSource,
    rawConfig: raw,
    sourceConfig: cfg,
  };
}

export function resolveTtsPrefsPath(config: ResolvedTtsConfig): string {
  return resolveTtsPrefsPathValue(config.prefsPath);
}

export function readTtsPrefs(prefsPath: string): TtsUserPrefs {
  try {
    if (!existsSync(prefsPath)) {
      return {};
    }
    const parsed: unknown = JSON.parse(readFileSync(prefsPath, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as TtsUserPrefs)
      : {};
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

export function resolveTtsAutoMode(params: {
  config: ResolvedTtsConfig;
  prefsPath: string;
  sessionAuto?: string;
}): TtsAutoMode {
  const sessionAuto = normalizeTtsAutoMode(params.sessionAuto);
  if (sessionAuto) {
    return sessionAuto;
  }
  return resolveTtsAutoModeFromPrefs(readTtsPrefs(params.prefsPath)) ?? params.config.auto;
}

function resolveTtsPersonaIdFromPrefs(
  config: ResolvedTtsConfig,
  prefs: TtsUserPrefs,
): string | undefined {
  if (prefs.tts && hasOwnProperty(prefs.tts, "persona")) {
    return normalizeTtsPersonaId(prefs.tts.persona);
  }
  return normalizeTtsPersonaId(config.persona);
}

export function resolveTtsPersonaFromPrefs(
  config: ResolvedTtsConfig,
  prefs: TtsUserPrefs,
): ResolvedTtsPersona | undefined {
  const personaId = resolveTtsPersonaIdFromPrefs(config, prefs);
  return personaId ? config.personas[personaId] : undefined;
}

type ResolvedTtsSettingsSnapshot = {
  autoMode: TtsAutoMode;
  config: ResolvedTtsConfig;
  maxLength: number;
  persona?: ResolvedTtsPersona;
  personaId?: string;
  preferredProvider?: TtsProvider;
  prefsPath: string;
  summarize: boolean;
};

export function resolveTtsSettingsSnapshot(params: {
  cfg: OpenClawConfig;
  sessionAuto?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}): ResolvedTtsSettingsSnapshot {
  const config = resolveTtsConfig(params.cfg, {
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  const prefsPath = resolveTtsPrefsPath(config);
  const prefs = readTtsPrefs(prefsPath);
  const personaId = resolveTtsPersonaIdFromPrefs(config, prefs);
  const persona = personaId ? config.personas[personaId] : undefined;
  const preferredProvider =
    normalizeConfiguredSpeechProviderId(prefs.tts?.provider) ??
    normalizeConfiguredSpeechProviderId(persona?.provider) ??
    (config.providerSource === "config"
      ? (normalizeConfiguredSpeechProviderId(config.provider) ?? config.provider)
      : undefined);
  return {
    autoMode:
      normalizeTtsAutoMode(params.sessionAuto) ?? resolveTtsAutoModeFromPrefs(prefs) ?? config.auto,
    config,
    maxLength: prefs.tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH,
    ...(persona ? { persona } : {}),
    ...(personaId ? { personaId } : {}),
    ...(preferredProvider ? { preferredProvider } : {}),
    prefsPath,
    summarize: prefs.tts?.summarize ?? DEFAULT_TTS_SUMMARIZE,
  };
}

export function buildTtsSystemPromptHint(
  cfg: OpenClawConfig,
  agentId?: string,
): string | undefined {
  const settings = resolveTtsSettingsSnapshot({ cfg, agentId });
  if (settings.autoMode === "off") {
    return undefined;
  }
  const autoHint =
    settings.autoMode === "inbound"
      ? "Only use TTS when the user's last message includes audio/voice."
      : settings.autoMode === "tagged"
        ? "Only use TTS when you include [[tts:key=value]] directives or a [[tts:text]]...[[/tts:text]] block."
        : undefined;
  return [
    "Voice (TTS) is enabled.",
    autoHint,
    settings.persona
      ? `Active TTS persona: ${settings.persona.label ?? settings.persona.id}${settings.persona.description ? ` - ${settings.persona.description}` : ""}.`
      : undefined,
    `Keep spoken text ≤${settings.maxLength} chars to avoid auto-summary (summary ${settings.summarize ? "on" : "off"}).`,
    "If workspace context (especially MEMORY.md) tells you not to use [[tts:...]] or to use a local/non-tagged voice workflow, follow that workspace instruction instead.",
    "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function isTtsEnabled(
  config: ResolvedTtsConfig,
  prefsPath: string,
  sessionAuto?: string,
): boolean {
  return resolveTtsAutoMode({ config, prefsPath, sessionAuto }) !== "off";
}

export function getTtsPersona(
  config: ResolvedTtsConfig,
  prefsPath: string,
): ResolvedTtsPersona | undefined {
  return resolveTtsPersonaFromPrefs(config, readTtsPrefs(prefsPath));
}

export function listTtsPersonas(config: ResolvedTtsConfig): ResolvedTtsPersona[] {
  return Object.values(config.personas).toSorted((left, right) => left.id.localeCompare(right.id));
}

export function getTtsMaxLength(prefsPath: string): number {
  return readTtsPrefs(prefsPath).tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH;
}

export function isSummarizationEnabled(prefsPath: string): boolean {
  return readTtsPrefs(prefsPath).tts?.summarize ?? DEFAULT_TTS_SUMMARIZE;
}
