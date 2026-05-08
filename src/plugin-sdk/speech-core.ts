// Shared speech-provider implementation helpers for bundled and third-party plugins.

export type { SpeechProviderPlugin } from "../plugins/types.js";
export type { ResolvedTtsConfig, ResolvedTtsModelOverrides } from "../tts/tts-types.js";
export type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechListVoicesRequest,
  SpeechModelOverridePolicy,
  SpeechProviderConfig,
  SpeechProviderConfiguredContext,
  SpeechProviderPreparedSynthesis,
  SpeechProviderPrepareSynthesisContext,
  SpeechProviderResolveConfigContext,
  SpeechProviderResolveTalkConfigContext,
  SpeechProviderResolveTalkOverridesContext,
  SpeechProviderOverrides,
  SpeechSynthesisRequest,
  SpeechSynthesisStreamRequest,
  SpeechSynthesisStreamResult,
  SpeechSynthesisTarget,
  SpeechTelephonySynthesisRequest,
  SpeechVoiceOption,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "../tts/provider-types.js";

export {
  scheduleCleanup,
  summarizeText,
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
} from "../tts/tts-core.js";
export { parseTtsDirectives } from "../tts/directives.js";
export {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listLoadedSpeechProviders,
  listSpeechProviders,
  normalizeSpeechProviderId,
} from "../tts/provider-registry.js";
export { resolveEffectiveTtsConfig } from "../tts/tts-config.js";
export type { TtsConfigResolutionContext } from "../tts/tts-config.js";
export { normalizeTtsAutoMode, TTS_AUTO_MODES } from "../tts/tts-auto-mode.js";
export {
  asBoolean,
  asFiniteNumber,
  asObject,
  assertOkOrThrowProviderError,
  createProviderHttpError,
  extractProviderErrorDetail,
  extractProviderRequestId,
  formatProviderErrorPayload,
  formatProviderHttpErrorMessage,
  readResponseTextLimited,
  trimToUndefined,
  truncateErrorDetail,
} from "../agents/provider-http-errors.js";
