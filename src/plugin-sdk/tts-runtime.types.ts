// TTS runtime types define plugin-facing text-to-speech synthesis hooks and results.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolvedTtsPersona, TtsAutoMode, TtsProvider } from "../config/types.tts.js";
import type {
  SpeechProviderConfig,
  SpeechVoiceOption,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "../tts/provider-types.js";
import type { TtsConfigResolutionContext } from "../tts/tts-config.js";
import type { ResolvedTtsConfig, ResolvedTtsModelOverrides } from "../tts/tts-types.js";
import type { ReplyPayload } from "./reply-payload.js";

export type { ResolvedTtsConfig, ResolvedTtsModelOverrides };
export type { TtsConfigResolutionContext };
export type { TtsDirectiveOverrides, TtsDirectiveParseResult };

/** Stable reason codes for one provider attempt in a TTS fallback chain. */
export type TtsAttemptReasonCode =
  | "success"
  | "no_provider_registered"
  | "not_configured"
  | "unsupported_for_streaming"
  | "unsupported_for_telephony"
  | "timeout"
  | "provider_error";

/** Per-provider attempt record used in TTS status, logs, and result metadata. */
export type TtsProviderAttempt = {
  provider: string;
  outcome: "success" | "skipped" | "failed";
  reasonCode: TtsAttemptReasonCode;
  persona?: string;
  personaBinding?: "applied" | "missing" | "none";
  latencyMs?: number;
  error?: string;
};

/** Last-attempt status snapshot exposed by the TTS runtime facade. */
export type TtsStatusEntry = {
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

/** Delivery target requested for synthesized speech output. */
export type TtsSpeechTarget = "audio-file" | "voice-note";

/** Summary metadata returned when long text is condensed before synthesis. */
export type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};

/** Inputs for resolving effective auto-TTS mode from config and session override. */
export type ResolveTtsAutoModeParams = {
  config: ResolvedTtsConfig;
  prefsPath: string;
  sessionAuto?: string;
};

/** Inputs for explicit provider/model/voice overrides parsed from user or tool directives. */
export type ResolveExplicitTtsOverridesParams = {
  cfg: OpenClawConfig;
  prefsPath?: string;
  provider?: string;
  modelId?: string;
  voiceId?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
};

/** Standard text-to-speech request for file or stream synthesis. */
export type TtsRequestParams = {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
};

/** Telephony-specific synthesis request where output format is constrained by the caller. */
export type TtsTelephonyRequestParams = {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  overrides?: TtsDirectiveOverrides;
};

/** Inputs for listing voices from a speech provider with optional resolved config. */
export type ListSpeechVoicesParams = {
  provider: string;
  cfg?: OpenClawConfig;
  config?: ResolvedTtsConfig;
  apiKey?: string;
  baseUrl?: string;
};

/** Inputs for attaching synthesized speech to an outbound reply payload when enabled. */
export type MaybeApplyTtsToPayloadParams = {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
  agentId?: string;
  accountId?: string;
};

/** Test-only helpers exported so plugin and channel tests share TTS policy decisions. */
export type TtsTestFacade = {
  parseTtsDirectives: (...args: unknown[]) => TtsDirectiveParseResult;
  resolveModelOverridePolicy: (...args: unknown[]) => ResolvedTtsModelOverrides;
  supportsNativeVoiceNoteTts: (channel: string | undefined) => boolean;
  supportsTranscodedVoiceNoteTts: (channel: string | undefined) => boolean;
  shouldDeliverTtsAsVoice: (params: {
    channel: string | undefined;
    target: TtsSpeechTarget | undefined;
    voiceCompatible: boolean | undefined;
    fileExtension?: string;
    outputFormat?: string;
  }) => boolean;
  summarizeText: (...args: unknown[]) => Promise<SummarizeResult>;
  getResolvedSpeechProviderConfig: (
    config: ResolvedTtsConfig,
    providerId: string,
    cfg?: OpenClawConfig,
  ) => SpeechProviderConfig;
  formatTtsProviderError: (provider: TtsProvider, err: unknown) => string;
  sanitizeTtsErrorForLog: (err: unknown) => string;
};

/** File-backed text-to-speech result returned by high-level runtime helpers. */
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
  target?: TtsSpeechTarget;
};

/** Buffer-backed synthesis result returned by lower-level provider orchestration. */
export type TtsSynthesisResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  providerModel?: string;
  providerVoice?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  voiceCompatible?: boolean;
  fileExtension?: string;
  target?: TtsSpeechTarget;
};

/** Stream-backed synthesis result with optional release hook for provider resources. */
export type TtsStreamResult = {
  success: boolean;
  audioStream?: ReadableStream<Uint8Array>;
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
  target?: TtsSpeechTarget;
  release?: () => Promise<void>;
};

/** @deprecated Use `TtsStreamResult`. */
export type TtsSynthesisStreamResult = TtsStreamResult;

/** Telephony synthesis result with provider voice/model and sample-rate metadata. */
export type TtsTelephonyResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  providerModel?: string;
  providerVoice?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  sampleRate?: number;
};

/** High-level function contract for file-backed text-to-speech synthesis. */
export type TextToSpeech = (params: TtsRequestParams) => Promise<TtsResult>;
/** High-level function contract for streaming text-to-speech synthesis. */
export type TextToSpeechStream = (params: TtsRequestParams) => Promise<TtsStreamResult>;
/** High-level function contract for telephony-safe text-to-speech synthesis. */
export type TextToSpeechTelephony = (
  params: TtsTelephonyRequestParams,
) => Promise<TtsTelephonyResult>;
/** Function contract for provider voice discovery. */
export type ListSpeechVoices = (params: ListSpeechVoicesParams) => Promise<SpeechVoiceOption[]>;

/** Complete TTS runtime facade exposed to SDK consumers and bundled provider tests. */
export type TtsRuntimeFacade = {
  /** @deprecated Use `testApi`. */
  _test: TtsTestFacade;
  testApi: TtsTestFacade;
  buildTtsSystemPromptHint: (cfg: OpenClawConfig, agentId?: string) => string | undefined;
  getLastTtsAttempt: () => TtsStatusEntry | undefined;
  getResolvedSpeechProviderConfig: (
    config: ResolvedTtsConfig,
    providerId: string,
    cfg?: OpenClawConfig,
  ) => SpeechProviderConfig;
  getTtsMaxLength: (prefsPath: string) => number;
  getTtsPersona: (config: ResolvedTtsConfig, prefsPath: string) => ResolvedTtsPersona | undefined;
  getTtsProvider: (config: ResolvedTtsConfig, prefsPath: string) => TtsProvider;
  isSummarizationEnabled: (prefsPath: string) => boolean;
  isTtsEnabled: (config: ResolvedTtsConfig, prefsPath: string, sessionAuto?: string) => boolean;
  isTtsProviderConfigured: (
    config: ResolvedTtsConfig,
    provider: TtsProvider,
    cfg?: OpenClawConfig,
  ) => boolean;
  listSpeechVoices: ListSpeechVoices;
  listTtsPersonas: (config: ResolvedTtsConfig) => ResolvedTtsPersona[];
  maybeApplyTtsToPayload: (params: MaybeApplyTtsToPayloadParams) => Promise<ReplyPayload>;
  resolveExplicitTtsOverrides: (params: ResolveExplicitTtsOverridesParams) => TtsDirectiveOverrides;
  resolveTtsAutoMode: (params: ResolveTtsAutoModeParams) => TtsAutoMode;
  resolveTtsConfig: (
    cfg: OpenClawConfig,
    contextOrAgentId?: string | TtsConfigResolutionContext,
  ) => ResolvedTtsConfig;
  resolveTtsPrefsPath: (config: ResolvedTtsConfig) => string;
  resolveTtsProviderOrder: (primary: TtsProvider, cfg?: OpenClawConfig) => TtsProvider[];
  setLastTtsAttempt: (entry: TtsStatusEntry | undefined) => void;
  setSummarizationEnabled: (prefsPath: string, enabled: boolean) => void;
  setTtsAutoMode: (prefsPath: string, mode: TtsAutoMode) => void;
  setTtsEnabled: (prefsPath: string, enabled: boolean) => void;
  setTtsMaxLength: (prefsPath: string, maxLength: number) => void;
  setTtsPersona: (prefsPath: string, persona: string | null | undefined) => void;
  setTtsProvider: (prefsPath: string, provider: TtsProvider) => void;
  synthesizeSpeech: (params: TtsRequestParams) => Promise<TtsSynthesisResult>;
  streamSpeech: (params: TtsRequestParams) => Promise<TtsSynthesisStreamResult>;
  textToSpeech: TextToSpeech;
  textToSpeechStream: TextToSpeechStream;
  textToSpeechTelephony: TextToSpeechTelephony;
};
