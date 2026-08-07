/** Public TTS runtime barrel exposed to core callers and plugin SDK facades. */
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  setSpeechRuntimeAvailabilityGuard,
  setTtsMachinePrefsPathResolver,
} from "./runtime-api.js";
import { persistTtsAudioToMediaStore } from "./tts-audio-store.js";
import { maybeApplyTtsToPayload as maybeApplyTtsToPayloadCore } from "./tts-payload.js";
import { textToSpeech as textToSpeechCore } from "./tts-synthesis.js";

setSpeechRuntimeAvailabilityGuard(() => {
  assertSecretOwnerAvailable("capability", "tts");
});

setTtsMachinePrefsPathResolver(() => readConfigMachineState<string>("tts.prefsPath"));

export function textToSpeech(params: Parameters<typeof textToSpeechCore>[0]) {
  return textToSpeechCore(params, persistTtsAudioToMediaStore);
}

export function maybeApplyTtsToPayload(params: Parameters<typeof maybeApplyTtsToPayloadCore>[0]) {
  return maybeApplyTtsToPayloadCore(params, persistTtsAudioToMediaStore);
}

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
  resolveExplicitTtsOverrides,
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
  type ResolvedTtsConfig,
  type TtsDirectiveOverrides,
} from "./runtime-api.js";
