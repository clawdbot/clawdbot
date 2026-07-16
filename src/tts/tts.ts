/**
 * Public TTS runtime barrel exposed to core callers and plugin SDK facades.
 * Implementation stays in plugin-sdk/tts-runtime so provider surfaces share one contract.
 */
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
  setTtsEnabled,
  setTtsMaxLength,
  setTtsPersona,
  setTtsProvider,
  synthesizeSpeech,
  textToSpeech,
  type ResolvedTtsConfig,
  type TtsDirectiveOverrides,
} from "../plugin-sdk/tts-runtime.js";
