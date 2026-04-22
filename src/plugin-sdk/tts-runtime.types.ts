import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TtsAutoMode, TtsProvider } from "../config/types.tts.js";
import type {
  SpeechProviderConfig,
  SpeechVoiceOption,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "../tts/provider-types.js";
import type { ResolvedTtsConfig, ResolvedTtsModelOverrides } from "../tts/tts-types.js";
import type { ReplyPayload } from "./reply-payload.js";

export type { ResolvedTtsConfig, ResolvedTtsModelOverrides };
export type { TtsDirectiveOverrides, TtsDirectiveParseResult };

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
  latencyMs?: number;
  error?: string;
};

export type TtsStatusEntry = {
  timestamp: number;
  success: boolean;
  textLength: number;
  summarized: boolean;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  latencyMs?: number;
  error?: string;
};

export type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};

export type ResolveTtsAutoModeParams = {
  config: ResolvedTtsConfig;
  prefsPath: string;
  sessionAuto?: string;
};

export type ResolveExplicitTtsOverridesParams = {
  cfg: OpenClawConfig;
  prefsPath?: string;
  provider?: string;
  modelId?: string;
  voiceId?: string;
};

export type TtsRequestParams = {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
};

export type TtsTelephonyRequestParams = {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
};

export type ListSpeechVoicesParams = {
  provider: string;
  cfg?: OpenClawConfig;
  config?: ResolvedTtsConfig;
  apiKey?: string;
  baseUrl?: string;
};

export type MaybeApplyTtsToPayloadParams = {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
};

export type TtsTestFacade = {
  parseTtsDirectives: (...args: unknown[]) => TtsDirectiveParseResult;
  resolveModelOverridePolicy: (...args: unknown[]) => ResolvedTtsModelOverrides;
  supportsNativeVoiceNoteTts: (channel: string | undefined) => boolean;
  summarizeText: (...args: unknown[]) => Promise<SummarizeResult>;
  getResolvedSpeechProviderConfig: (
    config: ResolvedTtsConfig,
    providerId: string,
    cfg?: OpenClawConfig,
  ) => SpeechProviderConfig;
  formatTtsProviderError: (provider: TtsProvider, err: unknown) => string;
  sanitizeTtsErrorForLog: (err: unknown) => string;
};

export type TtsResult = {
  success: boolean;
  audioPath?: string;
  error?: string;
  latencyMs?: number;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  voiceCompatible?: boolean;
};

export type TtsSynthesisResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  voiceCompatible?: boolean;
  fileExtension?: string;
};

export type TtsTelephonyResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  sampleRate?: number;
};

export type TextToSpeech = (params: TtsRequestParams) => Promise<TtsResult>;
export type TextToSpeechTelephony = (
  params: TtsTelephonyRequestParams,
) => Promise<TtsTelephonyResult>;
export type ListSpeechVoices = (params: ListSpeechVoicesParams) => Promise<SpeechVoiceOption[]>;

export type TtsRuntimeFacade = {
  _test: TtsTestFacade;
  buildTtsSystemPromptHint: (cfg: OpenClawConfig) => string | undefined;
  getLastTtsAttempt: () => TtsStatusEntry | undefined;
  getResolvedSpeechProviderConfig: (
    config: ResolvedTtsConfig,
    providerId: string,
    cfg?: OpenClawConfig,
  ) => SpeechProviderConfig;
  getTtsMaxLength: (prefsPath: string) => number;
  getTtsProvider: (config: ResolvedTtsConfig, prefsPath: string) => TtsProvider;
  isSummarizationEnabled: (prefsPath: string) => boolean;
  isTtsEnabled: (config: ResolvedTtsConfig, prefsPath: string, sessionAuto?: string) => boolean;
  isTtsProviderConfigured: (
    config: ResolvedTtsConfig,
    provider: TtsProvider,
    cfg?: OpenClawConfig,
  ) => boolean;
  listSpeechVoices: ListSpeechVoices;
  maybeApplyTtsToPayload: (params: MaybeApplyTtsToPayloadParams) => Promise<ReplyPayload>;
  resolveExplicitTtsOverrides: (params: ResolveExplicitTtsOverridesParams) => TtsDirectiveOverrides;
  resolveTtsAutoMode: (params: ResolveTtsAutoModeParams) => TtsAutoMode;
  resolveTtsConfig: (cfg: OpenClawConfig) => ResolvedTtsConfig;
  resolveTtsPrefsPath: (config: ResolvedTtsConfig) => string;
  resolveTtsProviderOrder: (primary: TtsProvider, cfg?: OpenClawConfig) => TtsProvider[];
  setLastTtsAttempt: (entry: TtsStatusEntry | undefined) => void;
  setSummarizationEnabled: (prefsPath: string, enabled: boolean) => void;
  setTtsAutoMode: (prefsPath: string, mode: TtsAutoMode) => void;
  setTtsEnabled: (prefsPath: string, enabled: boolean) => void;
  setTtsMaxLength: (prefsPath: string, maxLength: number) => void;
  setTtsProvider: (prefsPath: string, provider: TtsProvider) => void;
  synthesizeSpeech: (params: TtsRequestParams) => Promise<TtsSynthesisResult>;
  textToSpeech: TextToSpeech;
  textToSpeechTelephony: TextToSpeechTelephony;
};
