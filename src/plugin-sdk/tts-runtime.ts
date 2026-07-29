// TTS runtime exports expose text-to-speech runtime helpers through the plugin SDK.
import { maybeApplyTtsToPayload as maybeApplyTtsToPayloadCore } from "../../packages/speech-core/src/tts-payload.js";
import { textToSpeech as textToSpeechCore } from "../../packages/speech-core/src/tts-synthesis.js";
import { persistTtsAudioToMediaStore } from "../tts/tts-audio-store.js";

export type { TtsResult } from "../../packages/speech-core/src/tts-types.js";

export function textToSpeech(params: Parameters<typeof textToSpeechCore>[0]) {
  return textToSpeechCore(params, persistTtsAudioToMediaStore);
}

export function maybeApplyTtsToPayload(params: Parameters<typeof maybeApplyTtsToPayloadCore>[0]) {
  return maybeApplyTtsToPayloadCore(params, persistTtsAudioToMediaStore);
}

export {
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "../config/zod-schema.core.js";

/** Compatibility no-op retained for callers that prewarm facade runtimes generically. */
export function prewarmTtsRuntimeFacade(): void {}

// Pure synthesis stays in speech-core. File-backed helpers above inject the
// core media-store owner so package code never imports from src.
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
} from "../../packages/speech-core/runtime-api.js";
