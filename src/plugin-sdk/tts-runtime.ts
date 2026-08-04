// TTS runtime exports expose host-owned text-to-speech helpers through the plugin SDK.
export { maybeApplyTtsToPayload, textToSpeech } from "../tts/tts.js";
export type { TtsResult } from "../tts/tts-runtime-types.js";

export {
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "../config/zod-schema.core.js";

/** Compatibility no-op retained for callers that prewarm facade runtimes generically. */
export function prewarmTtsRuntimeFacade(): void {}

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
  textToSpeechStream,
  textToSpeechTelephony,
  testApi,
  testApi as _test,
  type ResolvedTtsConfig,
  type ResolvedTtsModelOverrides,
  type TtsDirectiveOverrides,
  type TtsDirectiveParseResult,
  type TtsSynthesisResult,
  type TtsSynthesisStreamResult,
  type TtsStreamResult,
  type TtsTelephonyResult,
} from "../tts/runtime-api.js";
