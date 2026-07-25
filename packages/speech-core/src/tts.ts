import type { TtsProvider } from "openclaw/plugin-sdk/config-contracts";
import { parseTtsDirectives, summarizeText } from "openclaw/plugin-sdk/speech-core";
import { getResolvedSpeechProviderConfig, resolveTtsProvider } from "./tts-provider-resolution.js";
import { resolveModelOverridePolicy, type ResolvedTtsConfig } from "./tts-settings.js";
import { formatTtsProviderError, sanitizeTtsErrorForLog } from "./tts-synthesis-support.js";
import {
  shouldDeliverTtsAsVoice,
  supportsNativeVoiceNoteTts,
  supportsTranscodedVoiceNoteTts,
  resolveTtsSynthesisTarget,
} from "./tts-synthesis.js";

export type {
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "openclaw/plugin-sdk/speech-core";

export function getTtsProvider(config: ResolvedTtsConfig, prefsPath: string): TtsProvider {
  return resolveTtsProvider(config, prefsPath);
}

export {
  getLastTtsAttempt,
  listSpeechVoices,
  maybeApplyTtsToPayload,
  setLastTtsAttempt,
} from "./tts-payload.js";
export {
  getResolvedSpeechProviderConfig,
  isTtsProviderConfigured,
  resolveTtsProviderOrder,
} from "./tts-provider-resolution.js";
export {
  prepareTtsRequest,
  resolveExplicitTtsOverrides,
  type PreparedTtsRequest,
} from "./tts-request.js";
export { streamSpeech, textToSpeechStream } from "./tts-streaming.js";
export { synthesizeSpeech, textToSpeech } from "./tts-synthesis.js";
export { textToSpeechTelephony } from "./tts-telephony.js";
export type {
  TtsResult,
  TtsStreamResult,
  TtsSynthesisResult,
  TtsSynthesisStreamResult,
  TtsTelephonyResult,
} from "./tts-types.js";

export const testApi = {
  parseTtsDirectives,
  resolveModelOverridePolicy,
  supportsNativeVoiceNoteTts,
  supportsTranscodedVoiceNoteTts,
  resolveTtsSynthesisTarget,
  shouldDeliverTtsAsVoice,
  summarizeText,
  getResolvedSpeechProviderConfig,
  formatTtsProviderError,
  sanitizeTtsErrorForLog,
};
