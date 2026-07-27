// TTS runtime exports expose text-to-speech runtime helpers through the plugin SDK.
export {
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "../config/zod-schema.core.js";

/** Compatibility no-op retained for callers that prewarm facade runtimes generically. */
export function prewarmTtsRuntimeFacade(): void {}

// TTS runtime helpers are owned by speech-core; this SDK facade stays as a thin
// export barrel so public imports do not depend on bundled plugin internals.
export {
  buildTtsSystemPromptHint,
  getLastTtsAttempt,
  getResolvedSpeechProviderConfig,
  getTtsMaxLength,
  getTtsPersona,
  getTtsProvider,
  isSummarizationEnabled,
  isTtsEnabled,
  isTtsProviderConfigured,
  listSpeechVoices,
  listTtsPersonas,
  maybeApplyTtsToPayload,
  resolveExplicitTtsOverrides,
  resolveTtsAutoMode,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsProviderOrder,
  setLastTtsAttempt,
  setSummarizationEnabled,
  setTtsAutoMode,
  setTtsEnabled,
  setTtsMaxLength,
  setTtsPersona,
  setTtsProvider,
  synthesizeSpeech,
  streamSpeech,
  textToSpeech,
  textToSpeechStream,
  textToSpeechTelephony,
  testApi,
  testApi as _test,
  type ResolvedTtsConfig,
  type ResolvedTtsModelOverrides,
  type TtsDirectiveOverrides,
  type TtsDirectiveParseResult,
  type TtsResult,
  type TtsSynthesisResult,
  type TtsSynthesisStreamResult,
  type TtsStreamResult,
  type TtsTelephonyResult,
} from "../../packages/speech-core/runtime-api.js";
