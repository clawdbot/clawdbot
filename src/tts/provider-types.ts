// TTS provider types describe speech provider config and synthesize APIs.
import type { TalkProviderConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ResolvedTtsPersona } from "../config/types.tts.js";

/** Canonical speech provider identifier after provider registry normalization. */
export type SpeechProviderId = string;

/** Output context requested from a speech provider. */
export type SpeechSynthesisTarget = "audio-file" | "voice-note" | "telephony";

/** Provider-owned normalized config map. */
export type SpeechProviderConfig = Record<string, unknown>;

/** Provider-owned per-request directive/persona overrides. */
export type SpeechProviderOverrides = Record<string, unknown>;

/** Policy controlling which [[tts:*]] directive fields can affect synthesis. */
export type SpeechModelOverridePolicy = {
  enabled: boolean;
  allowText: boolean;
  allowProvider: boolean;
  allowVoice: boolean;
  allowModelId: boolean;
  allowVoiceSettings: boolean;
  allowNormalization: boolean;
  allowSeed: boolean;
};

/** Parsed directive overrides grouped by provider. */
export type TtsDirectiveOverrides = {
  ttsText?: string;
  provider?: SpeechProviderId;
  providerOverrides?: Record<string, SpeechProviderOverrides>;
};

/** Result of parsing TTS directives from message text. */
export type TtsDirectiveParseResult = {
  cleanedText: string;
  ttsText?: string;
  hasDirective: boolean;
  overrides: TtsDirectiveOverrides;
  warnings: string[];
};

/** Context for checking whether a provider has enough config to synthesize. */
export type SpeechProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  timeoutMs: number;
};

/** Request for buffered speech synthesis. */
export type SpeechSynthesisRequest = {
  text: string;
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  target: SpeechSynthesisTarget;
  providerOverrides?: SpeechProviderOverrides;
  timeoutMs: number;
};

/** Buffered speech synthesis result plus file/voice-note compatibility metadata. */
export type SpeechSynthesisResult = {
  audioBuffer: Buffer;
  outputFormat: string;
  fileExtension: string;
  voiceCompatible: boolean;
};

export type SpeechSynthesisStreamRequest = SpeechSynthesisRequest;

/** Streaming speech synthesis result; release frees provider transport resources. */
export type SpeechSynthesisStreamResult = {
  audioStream: ReadableStream<Uint8Array>;
  outputFormat: string;
  fileExtension: string;
  voiceCompatible: boolean;
  release?: () => Promise<void>;
};

/** Telephony synthesis request for provider output that needs a fixed sample rate. */
export type SpeechTelephonySynthesisRequest = {
  text: string;
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
  timeoutMs: number;
};

/** Telephony synthesis result with sample-rate metadata for call transports. */
export type SpeechTelephonySynthesisResult = {
  audioBuffer: Buffer;
  outputFormat: string;
  sampleRate: number;
};

/** Provider hook input for applying persona/config before synthesis. */
export type SpeechProviderPrepareSynthesisContext = {
  text: string;
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
  persona?: ResolvedTtsPersona;
  personaProviderConfig?: SpeechProviderConfig;
  target: SpeechSynthesisTarget;
  timeoutMs: number;
};

/** Optional provider-prepared synthesis overrides. */
export type SpeechProviderPreparedSynthesis = {
  text?: string;
  providerConfig?: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
};

/** Voice metadata returned by provider list-voices hooks. */
export type SpeechVoiceOption = {
  id: string;
  name?: string;
  category?: string;
  description?: string;
  locale?: string;
  gender?: string;
  personalities?: string[];
};

/** Provider voice-listing request with optional direct auth/URL overrides. */
export type SpeechListVoicesRequest = {
  cfg?: OpenClawConfig;
  providerConfig?: SpeechProviderConfig;
  apiKey?: string;
  baseUrl?: string;
};

/** Provider hook input for resolving normalized config from raw OpenClaw config. */
export type SpeechProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: Record<string, unknown>;
  timeoutMs: number;
};

/** One parsed directive key/value plus current provider override state. */
export type SpeechDirectiveTokenParseContext = {
  key: string;
  value: string;
  policy: SpeechModelOverridePolicy;
  selectedProvider?: SpeechProviderId;
  providerConfig?: SpeechProviderConfig;
  currentOverrides?: SpeechProviderOverrides;
};

/** Provider directive parser result. */
export type SpeechDirectiveTokenParseResult = {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
};

/** Provider hook input for resolving talk-command speech config. */
export type SpeechProviderResolveTalkConfigContext = {
  cfg: OpenClawConfig;
  baseTtsConfig: Record<string, unknown>;
  talkProviderConfig: TalkProviderConfig;
  timeoutMs: number;
};

/** Provider hook input for per-call talk-command overrides. */
export type SpeechProviderResolveTalkOverridesContext = {
  talkProviderConfig: TalkProviderConfig;
  params: Record<string, unknown>;
};
