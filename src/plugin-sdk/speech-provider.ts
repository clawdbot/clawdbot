// Private provider construction helpers; keep registry and execution imports out of this leaf.
export type { SpeechProviderPlugin } from "../plugins/types.js";
export type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechListVoicesRequest,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechSynthesisRequest,
  SpeechSynthesisTarget,
  SpeechTelephonySynthesisRequest,
  SpeechVoiceOption,
} from "../tts/provider-types.js";
export {
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
  resolveSpeechProviderApiKey,
  scheduleCleanup,
} from "../tts/tts-provider-helpers.js";
export { parseSpeechDirectiveNumberOverride } from "../tts/directive-number.js";
export {
  createOpenAiCompatibleSpeechProvider,
  type OpenAiCompatibleSpeechProviderBaseUrlPolicy,
  type OpenAiCompatibleSpeechProviderConfig,
  type OpenAiCompatibleSpeechProviderExtraJsonBodyField,
  type OpenAiCompatibleSpeechProviderOptions,
} from "../tts/openai-compatible-speech-provider.js";

export { MAX_AUDIO_BYTES } from "@openclaw/media-core/constants";

export { retryAsync } from "../infra/retry.js";
export { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
