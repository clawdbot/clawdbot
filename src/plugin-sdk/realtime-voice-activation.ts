/**
 * Dependency-light realtime-voice activation-name helpers.
 *
 * Doctor contract closures (e.g. Discord's wake-name migrations) need these
 * pure helpers; the broad `realtime-voice` barrel also value-loads the agent
 * consult runtime and session graphs, which enumeration must not cold-load.
 */
export {
  REALTIME_VOICE_ACTIVATION_NAME_MAX_WORDS,
  isSupportedRealtimeVoiceActivationName,
  matchRealtimeVoiceActivationName,
  normalizeRealtimeVoiceActivationName,
  normalizeRealtimeVoiceActivationNamePrefix,
  normalizeSupportedRealtimeVoiceActivationName,
  realtimeVoiceActivationNameWordCount,
  sortRealtimeVoiceActivationNames,
  type RealtimeVoiceActivationNameEdge,
  type RealtimeVoiceActivationNameMatchKind,
  type RealtimeVoiceActivationNameTranscriptResult,
} from "../talk/activation-name.js";
