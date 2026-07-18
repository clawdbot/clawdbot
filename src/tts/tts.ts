/** Public TTS runtime barrel exposed to core callers and plugin SDK facades. */
import { setSpeechRuntimeAvailabilityGuard } from "../../packages/speech-core/runtime-api.js";
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";

setSpeechRuntimeAvailabilityGuard(() => {
  assertSecretOwnerAvailable("capability", "tts");
});

export {
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
