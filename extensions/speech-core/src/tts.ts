import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { resolveChannelTtsVoiceDelivery } from "openclaw/plugin-sdk/channel-targets";
import type {
  OpenClawConfig,
  ResolvedTtsPersona,
  TtsAutoMode,
  TtsConfig,
  TtsModelOverrideConfig,
  TtsProvider,
} from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { isVerbose, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  resolveConfigDir,
  resolveUserPath,
  stripMarkdown,
} from "openclaw/plugin-sdk/text-runtime";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
  normalizeSpeechProviderId,
  normalizeTtsAutoMode,
  parseTtsDirectives,
  resolveEffectiveTtsConfig,
  type ResolvedTtsConfig,
  type ResolvedTtsModelOverrides,
  scheduleCleanup,
  summarizeText,
  type SpeechProviderConfig,
  type SpeechProviderOverrides,
  type SpeechVoiceOption,
  type TtsDirectiveOverrides,
  type TtsDirectiveParseResult,
  type TtsConfigResolutionContext,
} from "../api.js";

export type {
  ResolvedTtsConfig,
  ResolvedTtsModelOverrides,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;
const DEFAULT_MAX_TEXT_LENGTH = 4096;

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

export type TtsAttemptReasonCode =
  | "success"
  | "no_provider_registered"
  | "not_configured"
  | "unsupported_for_telephony"
  | "timeout"
  | "provider_error";

export type TtsProviderAttempt = {
  provider: string;
  outcome: "success" | "skipped" | "failed";
  reasonCode: TtsAttemptReasonCode;
  persona?: string;
  personaBinding?: "applied" | "missing" | "none";
  latencyMs?: number;
  error?: string;
};

export type TtsResult = {
  success: boolean;
  audioPath?: string;
  error?: string;
  latencyMs?: number;
  provider?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  voiceCompatible?: boolean;
  audioAsVoice?: boolean;
  target?: "audio-file" | "voice-note";
};

export type TtsSynthesisResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  voiceCompatible?: boolean;
  fileExtension?: string;
  target?: "audio-file" | "voice-note";
};

export type TtsTelephonyResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  sampleRate?: number;
};

type TtsStatusEntry = {
  timestamp: number;
  success: boolean;
  textLength: number;
  summarized: boolean;
  provider?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  latencyMs?: number;
  error?: string;
};

let lastTtsAttempt: TtsStatusEntry | undefined;

function resolveConfiguredTtsAutoMode(raw: TtsConfig): TtsAutoMode {
  return normalizeTtsAutoMode(raw.auto) ?? (raw.enabled ? "always" : "off");
}

function normalizeConfiguredSpeechProviderId(
  providerId: string | undefined,
): TtsProvider | undefined {
  const normalized = normalizeSpeechProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return normalized === "edge" ? "microsoft" : normalized;
}

function normalizeTtsPersonaId(personaId: string | null | undefined): string | undefined {
  return normalizeOptionalLowercaseString(personaId ?? undefined);
}

function resolveTtsPrefsPathValue(prefsPath: string | undefined): string {
  if (prefsPath?.trim()) {
    return resolveUserPath(prefsPath.trim());
  }
  const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
  if (envPath) {
    return resolveUserPath(envPath);
  }
  return path.join(resolveConfigDir(process.env), "settings", "tts.json");
}

function resolveModelOverridePolicy(
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

function sortSpeechProvidersForAutoSelection(cfg?: OpenClawConfig) {
  return listSpeechProviders(cfg).toSorted((left, right) => {
    const leftOrder = left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

function _resolveRegistryDefaultSpeechProviderId(cfg?: OpenClawConfig): TtsProvider {
  return sortSpeechProvidersForAutoSelection(cfg)[0]?.id ?? "";
}

function asProviderConfig(value: unknown): SpeechProviderConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SpeechProviderConfig)
    : {};
}

function asProviderConfigMap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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

function resolvePersonaProviderConfig(
  persona: ResolvedTtsPersona | undefined,
  providerId: string,
): SpeechProviderConfig | undefined {
  if (!persona?.providers) {
    return undefined;
  }
  const normalized = normalizeConfiguredSpeechProviderId(providerId) ?? providerId;
  if (hasOwnProperty(persona.providers, normalized)) {
    return persona.providers[normalized];
  }
  if (hasOwnProperty(persona.providers, providerId)) {
    return persona.providers[providerId];
  }
  return undefined;
}

function mergeProviderConfigWithPersona(params: {
  providerConfig: SpeechProviderConfig;
  persona?: ResolvedTtsPersona;
  providerId: string;
}): {
  providerConfig: SpeechProviderConfig;
  personaProviderConfig?: SpeechProviderConfig;
  personaBinding: "applied" | "missing" | "none";
} {
  if (!params.persona) {
    return { providerConfig: params.providerConfig, personaBinding: "none" };
  }
  const personaProviderConfig = resolvePersonaProviderConfig(params.persona, params.providerId);
  if (!personaProviderConfig) {
    return { providerConfig: params.providerConfig, personaBinding: "missing" };
  }
  return {
    providerConfig: {
      ...params.providerConfig,
      ...personaProviderConfig,
    },
    personaProviderConfig,
    personaBinding: "applied",
  };
}

function resolveRawProviderConfig(
  raw: TtsConfig | undefined,
  providerId: string,
): SpeechProviderConfig {
  if (!raw) {
    return {};
  }
  const rawProviders = asProviderConfigMap(raw.providers);
  const direct = rawProviders[providerId] ?? (raw as Record<string, unknown>)[providerId];
  return asProviderConfig(direct);
}

function resolveLazyProviderConfig(
  config: ResolvedTtsConfig,
  providerId: string,
  cfg?: OpenClawConfig,
): SpeechProviderConfig {
  const canonical =
    normalizeConfiguredSpeechProviderId(providerId) ?? normalizeLowercaseStringOrEmpty(providerId);
  const existing = config.providerConfigs[canonical];
  const effectiveCfg = cfg ?? config.sourceConfig;
  if (existing && !effectiveCfg) {
    return existing;
  }
  const rawConfig = resolveRawProviderConfig(config.rawConfig, canonical);
  const resolvedProvider = getSpeechProvider(canonical, effectiveCfg);
  const next =
    effectiveCfg && resolvedProvider?.resolveConfig
      ? resolvedProvider.resolveConfig({
          cfg: effectiveCfg,
          rawConfig: {
            ...(config.rawConfig as Record<string, unknown> | undefined),
            providers: asProviderConfigMap(config.rawConfig?.providers),
          },
          timeoutMs: config.timeoutMs,
        })
      : rawConfig;
  config.providerConfigs[canonical] = next;
  return next;
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

export function getResolvedSpeechProviderConfig(
  config: ResolvedTtsConfig,
  providerId: string,
  cfg?: OpenClawConfig,
): SpeechProviderConfig {
  const canonical =
    canonicalizeSpeechProviderId(providerId, cfg) ??
    normalizeConfiguredSpeechProviderId(providerId) ??
    normalizeLowercaseStringOrEmpty(providerId);
  return resolveLazyProviderConfig(config, canonical, cfg);
}

export function resolveTtsConfig(
  cfg: OpenClawConfig,
  contextOrAgentId?: string | TtsConfigResolutionContext,
): ResolvedTtsConfig {
  const raw: TtsConfig = resolveEffectiveTtsConfig(cfg, contextOrAgentId);
  const providerSource = raw.provider ? "config" : "default";
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auto = resolveConfiguredTtsAutoMode(raw);
  const persona = normalizeTtsPersonaId(raw.persona);
  return {
    auto,
    mode: raw.mode ?? "final",
    provider:
      normalizeConfiguredSpeechProviderId(raw.provider) ??
      (providerSource === "config" ? (normalizeOptionalLowercaseString(raw.provider) ?? "") : ""),
    providerSource,
    persona,
    personas: collectTtsPersonas(raw),
    summaryModel: normalizeOptionalString(raw.summaryModel),
    modelOverrides: resolveModelOverridePolicy(raw.modelOverrides),
    providerConfigs: collectDirectProviderConfigEntries(raw),
    prefsPath: raw.prefsPath,
    maxTextLength: raw.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    timeoutMs,
    rawConfig: raw,
    sourceConfig: cfg,
  };
}

export function resolveTtsPrefsPath(config: ResolvedTtsConfig): string {
  return resolveTtsPrefsPathValue(config.prefsPath);
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
  const prefsAuto = resolveTtsAutoModeFromPrefs(readPrefs(params.prefsPath));
  if (prefsAuto) {
    return prefsAuto;
  }
  return params.config.auto;
}

function resolveEffectiveTtsAutoState(params: {
  cfg: OpenClawConfig;
  sessionAuto?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}): {
  autoMode: TtsAutoMode;
  prefsPath: string;
} {
  const raw: TtsConfig = resolveEffectiveTtsConfig(params.cfg, {
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  const prefsPath = resolveTtsPrefsPathValue(raw.prefsPath);
  const sessionAuto = normalizeTtsAutoMode(params.sessionAuto);
  if (sessionAuto) {
    return { autoMode: sessionAuto, prefsPath };
  }
  const prefsAuto = resolveTtsAutoModeFromPrefs(readPrefs(prefsPath));
  if (prefsAuto) {
    return { autoMode: prefsAuto, prefsPath };
  }
  return {
    autoMode: resolveConfiguredTtsAutoMode(raw),
    prefsPath,
  };
}

export function buildTtsSystemPromptHint(
  cfg: OpenClawConfig,
  agentId?: string,
): string | undefined {
  const { autoMode, prefsPath } = resolveEffectiveTtsAutoState({ cfg, agentId });
  if (autoMode === "off") {
    return undefined;
  }
  const _config = resolveTtsConfig(cfg, agentId);
  const persona = getTtsPersona(_config, prefsPath);
  const maxLength = getTtsMaxLength(prefsPath);
  const summarize = isSummarizationEnabled(prefsPath) ? "on" : "off";
  const autoHint =
    autoMode === "inbound"
      ? "Only use TTS when the user's last message includes audio/voice."
      : autoMode === "tagged"
        ? "Only use TTS when you include [[tts:key=value]] directives or a [[tts:text]]...[[/tts:text]] block."
        : undefined;
  return [
    "Voice (TTS) is enabled.",
    autoHint,
    persona
      ? `Active TTS persona: ${persona.label ?? persona.id}${persona.description ? ` - ${persona.description}` : ""}.`
      : undefined,
    `Keep spoken text ≤${maxLength} chars to avoid auto-summary (summary ${summarize}).`,
    "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
  ]
    .filter(Boolean)
    .join("\n");
}

function readPrefs(prefsPath: string): TtsUserPrefs {
  try {
    if (!existsSync(prefsPath)) {
      return {};
    }
    return JSON.parse(readFileSync(prefsPath, "utf8")) as TtsUserPrefs;
  } catch {
    return {};
  }
}

function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${randomBytes(8).toString("hex")}`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

function updatePrefs(prefsPath: string, update: (prefs: TtsUserPrefs) => void): void {
  const prefs = readPrefs(prefsPath);
  update(prefs);
  mkdirSync(path.dirname(prefsPath), { recursive: true });
  atomicWriteFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}

export function isTtsEnabled(
  config: ResolvedTtsConfig,
  prefsPath: string,
  sessionAuto?: string,
): boolean {
  return resolveTtsAutoMode({ config, prefsPath, sessionAuto }) !== "off";
}

export function setTtsAutoMode(prefsPath: string, mode: TtsAutoMode): void {
  updatePrefs(prefsPath, (prefs) => {
    const next = { ...prefs.tts };
    delete next.enabled;
    next.auto = mode;
    prefs.tts = next;
  });
}

export function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  setTtsAutoMode(prefsPath, enabled ? "always" : "off");
}

export function getTtsProvider(config: ResolvedTtsConfig, prefsPath: string): TtsProvider {
  const prefs = readPrefs(prefsPath);
  const prefsProvider =
    canonicalizeSpeechProviderId(prefs.tts?.provider) ??
    normalizeConfiguredSpeechProviderId(prefs.tts?.provider);
  if (prefsProvider) {
    return prefsProvider;
  }
  const activePersona = resolveTtsPersonaFromPrefs(config, prefs);
  const personaProvider =
    canonicalizeSpeechProviderId(activePersona?.provider, config.sourceConfig) ??
    normalizeConfiguredSpeechProviderId(activePersona?.provider);
  if (personaProvider && getSpeechProvider(personaProvider, config.sourceConfig)) {
    return personaProvider;
  }
  if (config.providerSource === "config") {
    return normalizeConfiguredSpeechProviderId(config.provider) ?? config.provider;
  }

  const effectiveCfg = config.sourceConfig;
  for (const provider of sortSpeechProvidersForAutoSelection(effectiveCfg)) {
    if (
      provider.isConfigured({
        cfg: effectiveCfg,
        providerConfig: config.providerConfigs[provider.id] ?? {},
        timeoutMs: config.timeoutMs,
      })
    ) {
      return provider.id;
    }
  }
  return config.provider;
}

function resolveTtsPersonaFromPrefs(
  config: ResolvedTtsConfig,
  prefs: TtsUserPrefs,
): ResolvedTtsPersona | undefined {
  if (prefs.tts && hasOwnProperty(prefs.tts, "persona")) {
    const prefsPersona = normalizeTtsPersonaId(prefs.tts.persona);
    return prefsPersona ? config.personas[prefsPersona] : undefined;
  }
  const configPersona = normalizeTtsPersonaId(config.persona);
  return configPersona ? config.personas[configPersona] : undefined;
}

export function getTtsPersona(
  config: ResolvedTtsConfig,
  prefsPath: string,
): ResolvedTtsPersona | undefined {
  return resolveTtsPersonaFromPrefs(config, readPrefs(prefsPath));
}

export function listTtsPersonas(config: ResolvedTtsConfig): ResolvedTtsPersona[] {
  return Object.values(config.personas).toSorted((left, right) => left.id.localeCompare(right.id));
}

export function setTtsPersona(prefsPath: string, persona: string | null | undefined): void {
  updatePrefs(prefsPath, (prefs) => {
    const next = { ...prefs.tts };
    const normalized = normalizeTtsPersonaId(persona);
    next.persona = normalized ?? null;
    prefs.tts = next;
  });
}

export function setTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, provider: canonicalizeSpeechProviderId(provider) ?? provider };
  });
}

export function resolveExplicitTtsOverrides(params: {
  cfg: OpenClawConfig;
  prefsPath?: string;
  provider?: string;
  modelId?: string;
  voiceId?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}): TtsDirectiveOverrides {
  const providerInput = params.provider?.trim();
  const modelId = params.modelId?.trim();
  const voiceId = params.voiceId?.trim();
  const config = resolveTtsConfig(params.cfg, {
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  const selectedProvider =
    canonicalizeSpeechProviderId(providerInput, params.cfg) ??
    (modelId || voiceId ? getTtsProvider(config, prefsPath) : undefined);

  if (providerInput && !selectedProvider) {
    throw new Error(`Unknown TTS provider "${providerInput}".`);
  }

  if (!modelId && !voiceId) {
    return selectedProvider ? { provider: selectedProvider } : {};
  }

  if (!selectedProvider) {
    throw new Error("TTS model or voice overrides require a resolved provider.");
  }

  const provider = getSpeechProvider(selectedProvider, params.cfg);
  if (!provider) {
    throw new Error(`speech provider ${selectedProvider} is not registered`);
  }
  if (!provider.resolveTalkOverrides) {
    throw new Error(
      `TTS provider "${selectedProvider}" does not support model or voice overrides.`,
    );
  }

  const providerOverrides = provider.resolveTalkOverrides({
    talkProviderConfig: {},
    params: {
      ...(voiceId ? { voiceId } : {}),
      ...(modelId ? { modelId } : {}),
    },
  });
  if ((voiceId || modelId) && (!providerOverrides || Object.keys(providerOverrides).length === 0)) {
    throw new Error(
      `TTS provider "${selectedProvider}" ignored the requested model or voice overrides.`,
    );
  }

  const overridesRecord = providerOverrides as SpeechProviderOverrides;
  return {
    provider: selectedProvider,
    providerOverrides: {
      [provider.id]: overridesRecord,
    },
  };
}

export function getTtsMaxLength(prefsPath: string): number {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH;
}

export function setTtsMaxLength(prefsPath: string, maxLength: number): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, maxLength };
  });
}

export function isSummarizationEnabled(prefsPath: string): boolean {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.summarize ?? DEFAULT_TTS_SUMMARIZE;
}

export function setSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, summarize: enabled };
  });
}

export function getLastTtsAttempt(): TtsStatusEntry | undefined {
  return lastTtsAttempt;
}

export function setLastTtsAttempt(entry: TtsStatusEntry | undefined): void {
  lastTtsAttempt = entry;
}

function supportsNativeVoiceNoteTts(channel: string | undefined): boolean {
  return resolveChannelTtsVoiceDelivery(channel) !== undefined;
}

function supportsTranscodedVoiceNoteTts(channel: string | undefined): boolean {
  const delivery = resolveChannelTtsVoiceDelivery(channel);
  return delivery?.synthesisTarget === "voice-note" && delivery.transcodesAudio === true;
}

function resolveTtsSynthesisTarget(channel: string | undefined): "audio-file" | "voice-note" {
  return resolveChannelTtsVoiceDelivery(channel)?.synthesisTarget ?? "audio-file";
}

function supportsAudioFileVoiceMemoOutput(params: {
  fileExtension?: string;
  outputFormat?: string;
  audioFileFormats?: readonly string[];
}): boolean {
  const formats = new Set(params.audioFileFormats?.map((format) => format.trim().toLowerCase()));
  if (formats.size === 0) {
    return false;
  }
  const extension = params.fileExtension?.trim().toLowerCase();
  if (extension && formats.has(extension.replace(/^\./, ""))) {
    return true;
  }
  const outputFormat = params.outputFormat?.trim().toLowerCase();
  return outputFormat ? formats.has(outputFormat) : false;
}

function shouldDeliverTtsAsVoice(params: {
  channel: string | undefined;
  target: "audio-file" | "voice-note" | undefined;
  voiceCompatible: boolean | undefined;
  fileExtension?: string;
  outputFormat?: string;
}): boolean {
  const delivery = resolveChannelTtsVoiceDelivery(params.channel);
  if (!delivery) {
    return false;
  }
  if (delivery.synthesisTarget === "audio-file") {
    return (
      params.target === "audio-file" &&
      supportsAudioFileVoiceMemoOutput({
        fileExtension: params.fileExtension,
        outputFormat: params.outputFormat,
        audioFileFormats: delivery.audioFileFormats,
      })
    );
  }
  if (params.target !== "voice-note") {
    return false;
  }
  return params.voiceCompatible === true || delivery.transcodesAudio === true;
}

export function resolveTtsProviderOrder(primary: TtsProvider, cfg?: OpenClawConfig): TtsProvider[] {
  const normalizedPrimary = canonicalizeSpeechProviderId(primary, cfg) ?? primary;
  const ordered = new Set<TtsProvider>([normalizedPrimary]);
  for (const provider of sortSpeechProvidersForAutoSelection(cfg)) {
    const normalized = provider.id;
    if (normalized !== normalizedPrimary) {
      ordered.add(normalized);
    }
  }
  return [...ordered];
}

export function isTtsProviderConfigured(
  config: ResolvedTtsConfig,
  provider: TtsProvider,
  cfg?: OpenClawConfig,
): boolean {
  const resolvedProvider = getSpeechProvider(provider, cfg);
  if (!resolvedProvider) {
    return false;
  }
  return (
    resolvedProvider.isConfigured({
      cfg,
      providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, cfg),
      timeoutMs: config.timeoutMs,
    }) ?? false
  );
}

function formatTtsProviderError(provider: TtsProvider, err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.name === "AbortError") {
    return `${provider}: request timed out`;
  }
  return `${provider}: ${redactSensitiveText(error.message)}`;
}

function sanitizeTtsErrorForLog(err: unknown): string {
  const raw = formatErrorMessage(err);
  return redactSensitiveText(raw).replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

function buildTtsFailureResult(
  errors: string[],
  attemptedProviders?: string[],
  attempts?: TtsProviderAttempt[],
  persona?: string,
): {
  success: false;
  error: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  persona?: string;
} {
  return {
    success: false,
    error: `TTS conversion failed: ${errors.join("; ") || "no providers available"}`,
    attemptedProviders,
    attempts,
    persona,
  };
}

type TtsProviderReadyResolution =
  | {
      kind: "ready";
      provider: NonNullable<ReturnType<typeof getSpeechProvider>>;
      providerConfig: SpeechProviderConfig;
      personaProviderConfig?: SpeechProviderConfig;
      synthesisPersona?: ResolvedTtsPersona;
      personaBinding: "applied" | "missing" | "none";
    }
  | {
      kind: "skip";
      reasonCode: "no_provider_registered" | "not_configured" | "unsupported_for_telephony";
      message: string;
      personaBinding?: "missing";
    };

function resolveReadySpeechProvider(params: {
  provider: TtsProvider;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  persona?: ResolvedTtsPersona;
  requireTelephony?: boolean;
}): TtsProviderReadyResolution {
  const resolvedProvider = getSpeechProvider(params.provider, params.cfg);
  if (!resolvedProvider) {
    return {
      kind: "skip",
      reasonCode: "no_provider_registered",
      message: `${params.provider}: no provider registered`,
    };
  }
  const providerConfig = getResolvedSpeechProviderConfig(
    params.config,
    resolvedProvider.id,
    params.cfg,
  );
  const merged = mergeProviderConfigWithPersona({
    providerConfig,
    persona: params.persona,
    providerId: resolvedProvider.id,
  });
  if (params.persona?.fallbackPolicy === "fail" && merged.personaBinding === "missing") {
    return {
      kind: "skip",
      reasonCode: "not_configured",
      message: `${params.provider}: persona ${params.persona.id} has no provider binding`,
      personaBinding: "missing",
    };
  }
  if (
    !resolvedProvider.isConfigured({
      cfg: params.cfg,
      providerConfig: merged.providerConfig,
      timeoutMs: params.config.timeoutMs,
    })
  ) {
    return {
      kind: "skip",
      reasonCode: "not_configured",
      message: `${params.provider}: not configured`,
    };
  }
  if (params.requireTelephony && !resolvedProvider.synthesizeTelephony) {
    return {
      kind: "skip",
      reasonCode: "unsupported_for_telephony",
      message: `${params.provider}: unsupported for telephony`,
    };
  }
  return {
    kind: "ready",
    provider: resolvedProvider,
    providerConfig: merged.providerConfig,
    personaProviderConfig: merged.personaProviderConfig,
    synthesisPersona:
      params.persona?.fallbackPolicy === "provider-defaults" && merged.personaBinding === "missing"
        ? undefined
        : params.persona,
    personaBinding: merged.personaBinding,
  };
}

async function prepareSpeechSynthesis(params: {
  provider: NonNullable<ReturnType<typeof getSpeechProvider>>;
  text: string;
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
  persona?: ResolvedTtsPersona;
  personaProviderConfig?: SpeechProviderConfig;
  target: "audio-file" | "voice-note" | "telephony";
  timeoutMs: number;
}): Promise<{
  text: string;
  providerConfig: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
}> {
  if (!params.provider.prepareSynthesis) {
    return {
      text: params.text,
      providerConfig: params.providerConfig,
      providerOverrides: params.providerOverrides,
    };
  }
  const prepared = await params.provider.prepareSynthesis({
    text: params.text,
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    providerOverrides: params.providerOverrides,
    persona: params.persona,
    personaProviderConfig: params.personaProviderConfig,
    target: params.target,
    timeoutMs: params.timeoutMs,
  });
  return {
    text: prepared?.text ?? params.text,
    providerConfig: prepared?.providerConfig
      ? { ...params.providerConfig, ...prepared.providerConfig }
      : params.providerConfig,
    providerOverrides: prepared?.providerOverrides
      ? { ...params.providerOverrides, ...prepared.providerOverrides }
      : params.providerOverrides,
  };
}

function resolveTtsRequestSetup(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  providerOverride?: TtsProvider;
  disableFallback?: boolean;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}):
  | {
      config: ResolvedTtsConfig;
      persona?: ResolvedTtsPersona;
      providers: TtsProvider[];
    }
  | {
      error: string;
    } {
  const config = resolveTtsConfig(params.cfg, {
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  if (params.text.length > config.maxTextLength) {
    return {
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }

  const userProvider = getTtsProvider(config, prefsPath);
  const provider =
    canonicalizeSpeechProviderId(params.providerOverride, params.cfg) ?? userProvider;
  return {
    config,
    persona: getTtsPersona(config, prefsPath),
    providers: params.disableFallback ? [provider] : resolveTtsProviderOrder(provider, params.cfg),
  };
}

export async function textToSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
}): Promise<TtsResult> {
  const synthesis = await synthesizeSpeech(params);
  if (!synthesis.success || !synthesis.audioBuffer || !synthesis.fileExtension) {
    return {
      success: false,
      error: synthesis.error ?? "TTS conversion failed",
      persona: synthesis.persona,
      attemptedProviders: synthesis.attemptedProviders,
      attempts: synthesis.attempts,
    };
  }

  const tempRoot = resolvePreferredOpenClawTmpDir();
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const tempDir = mkdtempSync(path.join(tempRoot, "tts-"));
  const audioPath = path.join(tempDir, `voice-${Date.now()}${synthesis.fileExtension}`);
  writeFileSync(audioPath, synthesis.audioBuffer);
  scheduleCleanup(tempDir);

  return {
    success: true,
    audioPath,
    latencyMs: synthesis.latencyMs,
    provider: synthesis.provider,
    persona: synthesis.persona,
    fallbackFrom: synthesis.fallbackFrom,
    attemptedProviders: synthesis.attemptedProviders,
    attempts: synthesis.attempts,
    outputFormat: synthesis.outputFormat,
    voiceCompatible: synthesis.voiceCompatible,
    audioAsVoice: shouldDeliverTtsAsVoice({
      channel: params.channel,
      target: synthesis.target,
      voiceCompatible: synthesis.voiceCompatible,
      fileExtension: synthesis.fileExtension,
      outputFormat: synthesis.outputFormat,
    }),
    target: synthesis.target,
  };
}

export async function synthesizeSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
}): Promise<TtsSynthesisResult> {
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
    disableFallback: params.disableFallback,
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { config, persona, providers } = setup;
  const timeoutMs = params.timeoutMs ?? config.timeoutMs;
  const target = resolveTtsSynthesisTarget(params.channel);

  const errors: string[] = [];
  const attemptedProviders: string[] = [];
  const attempts: TtsProviderAttempt[] = [];
  const primaryProvider = providers[0];
  logVerbose(
    `TTS: starting with provider ${primaryProvider}, fallbacks: ${providers.slice(1).join(", ") || "none"}`,
  );

  for (const provider of providers) {
    attemptedProviders.push(provider);
    const providerStart = Date.now();
    try {
      const resolvedProvider = resolveReadySpeechProvider({
        provider,
        cfg: params.cfg,
        config,
        persona,
      });
      if (resolvedProvider.kind === "skip") {
        errors.push(resolvedProvider.message);
        attempts.push({
          provider,
          outcome: "skipped",
          reasonCode: resolvedProvider.reasonCode,
          persona: persona?.id,
          ...(resolvedProvider.personaBinding
            ? { personaBinding: resolvedProvider.personaBinding }
            : {}),
          error: resolvedProvider.message,
        });
        logVerbose(`TTS: provider ${provider} skipped (${resolvedProvider.message})`);
        continue;
      }
      const prepared = await prepareSpeechSynthesis({
        provider: resolvedProvider.provider,
        text: params.text,
        cfg: params.cfg,
        providerConfig: resolvedProvider.providerConfig,
        providerOverrides: params.overrides?.providerOverrides?.[resolvedProvider.provider.id],
        persona: resolvedProvider.synthesisPersona,
        personaProviderConfig: resolvedProvider.personaProviderConfig,
        target,
        timeoutMs,
      });
      const synthesis = await resolvedProvider.provider.synthesize({
        text: prepared.text,
        cfg: params.cfg,
        providerConfig: prepared.providerConfig,
        target,
        providerOverrides: prepared.providerOverrides,
        timeoutMs,
      });
      const latencyMs = Date.now() - providerStart;
      attempts.push({
        provider,
        outcome: "success",
        reasonCode: "success",
        persona: persona?.id,
        personaBinding: resolvedProvider.personaBinding,
        latencyMs,
      });
      return {
        success: true,
        audioBuffer: synthesis.audioBuffer,
        latencyMs,
        provider,
        persona: persona?.id,
        fallbackFrom: provider !== primaryProvider ? primaryProvider : undefined,
        attemptedProviders,
        attempts,
        outputFormat: synthesis.outputFormat,
        voiceCompatible: synthesis.voiceCompatible,
        fileExtension: synthesis.fileExtension,
        target,
      };
    } catch (err) {
      const errorMsg = formatTtsProviderError(provider, err);
      const latencyMs = Date.now() - providerStart;
      errors.push(errorMsg);
      attempts.push({
        provider,
        outcome: "failed",
        reasonCode:
          err instanceof Error && err.name === "AbortError" ? "timeout" : "provider_error",
        latencyMs,
        persona: persona?.id,
        personaBinding:
          resolvePersonaProviderConfig(persona, provider) != null
            ? "applied"
            : persona
              ? "missing"
              : "none",
        error: errorMsg,
      });
      const rawError = sanitizeTtsErrorForLog(err);
      if (provider === primaryProvider) {
        const hasFallbacks = providers.length > 1;
        logVerbose(
          `TTS: primary provider ${provider} failed (${rawError})${hasFallbacks ? "; trying fallback providers." : "; no fallback providers configured."}`,
        );
      } else {
        logVerbose(`TTS: ${provider} failed (${rawError}); trying next provider.`);
      }
    }
  }

  return buildTtsFailureResult(errors, attemptedProviders, attempts, persona?.id);
}

export async function textToSpeechTelephony(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
}): Promise<TtsTelephonyResult> {
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { config, persona, providers } = setup;
  const errors: string[] = [];
  const attemptedProviders: string[] = [];
  const attempts: TtsProviderAttempt[] = [];
  const primaryProvider = providers[0];
  logVerbose(
    `TTS telephony: starting with provider ${primaryProvider}, fallbacks: ${providers.slice(1).join(", ") || "none"}`,
  );

  for (const provider of providers) {
    attemptedProviders.push(provider);
    const providerStart = Date.now();
    try {
      const resolvedProvider = resolveReadySpeechProvider({
        provider,
        cfg: params.cfg,
        config,
        persona,
        requireTelephony: true,
      });
      if (resolvedProvider.kind === "skip") {
        errors.push(resolvedProvider.message);
        attempts.push({
          provider,
          outcome: "skipped",
          reasonCode: resolvedProvider.reasonCode,
          persona: persona?.id,
          ...(resolvedProvider.personaBinding
            ? { personaBinding: resolvedProvider.personaBinding }
            : {}),
          error: resolvedProvider.message,
        });
        logVerbose(`TTS telephony: provider ${provider} skipped (${resolvedProvider.message})`);
        continue;
      }
      const synthesizeTelephony = resolvedProvider.provider.synthesizeTelephony as NonNullable<
        typeof resolvedProvider.provider.synthesizeTelephony
      >;
      const prepared = await prepareSpeechSynthesis({
        provider: resolvedProvider.provider,
        text: params.text,
        cfg: params.cfg,
        providerConfig: resolvedProvider.providerConfig,
        persona: resolvedProvider.synthesisPersona,
        personaProviderConfig: resolvedProvider.personaProviderConfig,
        target: "telephony",
        timeoutMs: config.timeoutMs,
      });
      const synthesis = await synthesizeTelephony({
        text: prepared.text,
        cfg: params.cfg,
        providerConfig: prepared.providerConfig,
        timeoutMs: config.timeoutMs,
      });
      const latencyMs = Date.now() - providerStart;
      attempts.push({
        provider,
        outcome: "success",
        reasonCode: "success",
        persona: persona?.id,
        personaBinding: resolvedProvider.personaBinding,
        latencyMs,
      });

      return {
        success: true,
        audioBuffer: synthesis.audioBuffer,
        latencyMs,
        provider,
        persona: persona?.id,
        fallbackFrom: provider !== primaryProvider ? primaryProvider : undefined,
        attemptedProviders,
        attempts,
        outputFormat: synthesis.outputFormat,
        sampleRate: synthesis.sampleRate,
      };
    } catch (err) {
      const errorMsg = formatTtsProviderError(provider, err);
      const latencyMs = Date.now() - providerStart;
      errors.push(errorMsg);
      attempts.push({
        provider,
        outcome: "failed",
        reasonCode:
          err instanceof Error && err.name === "AbortError" ? "timeout" : "provider_error",
        latencyMs,
        persona: persona?.id,
        personaBinding:
          resolvePersonaProviderConfig(persona, provider) != null
            ? "applied"
            : persona
              ? "missing"
              : "none",
        error: errorMsg,
      });
      const rawError = sanitizeTtsErrorForLog(err);
      if (provider === primaryProvider) {
        const hasFallbacks = providers.length > 1;
        logVerbose(
          `TTS telephony: primary provider ${provider} failed (${rawError})${hasFallbacks ? "; trying fallback providers." : "; no fallback providers configured."}`,
        );
      } else {
        logVerbose(`TTS telephony: ${provider} failed (${rawError}); trying next provider.`);
      }
    }
  }

  return buildTtsFailureResult(errors, attemptedProviders, attempts, persona?.id);
}

export async function listSpeechVoices(params: {
  provider: string;
  cfg?: OpenClawConfig;
  config?: ResolvedTtsConfig;
  apiKey?: string;
  baseUrl?: string;
}): Promise<SpeechVoiceOption[]> {
  const provider = canonicalizeSpeechProviderId(params.provider, params.cfg);
  if (!provider) {
    throw new Error("speech provider id is required");
  }
  const config = params.config ?? (params.cfg ? resolveTtsConfig(params.cfg) : undefined);
  if (!config) {
    throw new Error(`speech provider ${provider} requires cfg or resolved config`);
  }
  const resolvedProvider = getSpeechProvider(provider, params.cfg);
  if (!resolvedProvider) {
    throw new Error(`speech provider ${provider} is not registered`);
  }
  if (!resolvedProvider.listVoices) {
    throw new Error(`speech provider ${provider} does not support voice listing`);
  }
  return await resolvedProvider.listVoices({
    cfg: params.cfg,
    providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, params.cfg),
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
  });
}

export async function maybeApplyTtsToPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
  agentId?: string;
  accountId?: string;
}): Promise<ReplyPayload> {
  if (params.payload.isCompactionNotice) {
    return params.payload;
  }
  const { autoMode, prefsPath } = resolveEffectiveTtsAutoState({
    cfg: params.cfg,
    sessionAuto: params.ttsAuto,
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  if (autoMode === "off") {
    return params.payload;
  }
  const config = resolveTtsConfig(params.cfg, {
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  const activeProvider = getTtsProvider(config, prefsPath);

  const reply = resolveSendableOutboundReplyParts(params.payload);
  const text = reply.text;
  const directives = parseTtsDirectives(text, config.modelOverrides, {
    cfg: params.cfg,
    providerConfigs: config.providerConfigs,
    preferredProviderId: activeProvider,
  });
  if (directives.warnings.length > 0) {
    logVerbose(`TTS: ignored directive overrides (${directives.warnings.join("; ")})`);
  }

  if (isVerbose()) {
    const effectiveProvider = directives.overrides?.provider
      ? (canonicalizeSpeechProviderId(directives.overrides.provider, params.cfg) ?? activeProvider)
      : activeProvider;
    logVerbose(
      `TTS: auto mode enabled (${autoMode}), channel=${params.channel}, selected provider=${effectiveProvider}, config.provider=${config.provider}, config.providerSource=${config.providerSource}`,
    );
  }

  const cleanedText = directives.cleanedText;
  const trimmedCleaned = cleanedText.trim();
  const visibleText = trimmedCleaned.length > 0 ? trimmedCleaned : "";
  const ttsText = directives.ttsText?.trim() || visibleText;

  const nextPayload =
    visibleText === text.trim()
      ? params.payload
      : {
          ...params.payload,
          text: visibleText.length > 0 ? visibleText : undefined,
        };

  if (autoMode === "tagged" && !directives.hasDirective) {
    return nextPayload;
  }
  if (autoMode === "inbound" && params.inboundAudio !== true) {
    return nextPayload;
  }

  const mode = config.mode ?? "final";
  if (mode === "final" && params.kind && params.kind !== "final") {
    return nextPayload;
  }

  if (!ttsText.trim()) {
    return nextPayload;
  }
  if (reply.hasMedia) {
    return nextPayload;
  }
  if (text.includes("MEDIA:")) {
    return nextPayload;
  }
  if (ttsText.trim().length < 10) {
    return nextPayload;
  }

  const maxLength = getTtsMaxLength(prefsPath);
  let textForAudio = ttsText.trim();
  let wasSummarized = false;

  if (textForAudio.length > maxLength) {
    if (!isSummarizationEnabled(prefsPath)) {
      logVerbose(
        `TTS: truncating long text (${textForAudio.length} > ${maxLength}), summarization disabled.`,
      );
      textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
    } else {
      try {
        const summary = await summarizeText({
          text: textForAudio,
          targetLength: maxLength,
          cfg: params.cfg,
          config,
          timeoutMs: config.timeoutMs,
        });
        textForAudio = summary.summary;
        wasSummarized = true;
        if (textForAudio.length > config.maxTextLength) {
          logVerbose(
            `TTS: summary exceeded hard limit (${textForAudio.length} > ${config.maxTextLength}); truncating.`,
          );
          textForAudio = `${textForAudio.slice(0, config.maxTextLength - 3)}...`;
        }
      } catch (err) {
        const error = err as Error;
        logVerbose(`TTS: summarization failed, truncating instead: ${error.message}`);
        textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
      }
    }
  }

  textForAudio = stripMarkdown(textForAudio).trim();
  if (textForAudio.length < 10) {
    return nextPayload;
  }

  const ttsStart = Date.now();
  const result = await textToSpeech({
    text: textForAudio,
    cfg: params.cfg,
    prefsPath,
    channel: params.channel,
    overrides: directives.overrides,
    agentId: params.agentId,
    accountId: params.accountId,
  });

  if (result.success && result.audioPath) {
    lastTtsAttempt = {
      timestamp: Date.now(),
      success: true,
      textLength: text.length,
      summarized: wasSummarized,
      provider: result.provider,
      persona: result.persona,
      fallbackFrom: result.fallbackFrom,
      attemptedProviders: result.attemptedProviders,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
    };

    return {
      ...nextPayload,
      mediaUrl: result.audioPath,
      audioAsVoice: result.audioAsVoice || params.payload.audioAsVoice,
    };
  }

  lastTtsAttempt = {
    timestamp: Date.now(),
    success: false,
    textLength: text.length,
    summarized: wasSummarized,
    persona: result.persona,
    attemptedProviders: result.attemptedProviders,
    attempts: result.attempts,
    error: result.error,
  };

  const latency = Date.now() - ttsStart;
  logVerbose(`TTS: conversion failed after ${latency}ms (${result.error ?? "unknown"}).`);
  return nextPayload;
}

export const _test = {
  parseTtsDirectives,
  resolveModelOverridePolicy,
  supportsNativeVoiceNoteTts,
  supportsTranscodedVoiceNoteTts,
  resolveTtsSynthesisTarget,
  shouldDeliverTtsAsVoice,
  summarizeText,
  getResolvedSpeechProviderConfig,
  formatTtsProviderError,
  sanitizeTtsErrorForLog,
};
