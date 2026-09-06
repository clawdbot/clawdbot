// Private provider primitives; session runtimes and provider registries stay outside this leaf.
export type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
export type {
  OpenAICompatibleRealtimeAudioFormat,
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "../talk/provider-types.js";
export {
  normalizeRealtimeVoiceResponseOutcome,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  realtimeVoiceAudioDurationMs,
  toOpenAICompatibleRealtimeAudioFormat,
} from "../talk/provider-types.js";
export {
  createRealtimeVoiceAudioQueue,
  RealtimeVoiceSessionLifecycle,
  type RealtimeVoiceAudioQueue,
  type RealtimeVoiceSessionConnection,
} from "../talk/realtime-session-lifecycle.js";
export {
  convertPcmToMulaw8k,
  createStreamingPcmResampler,
  mulawToPcm,
  pcmToMulaw,
  resamplePcm,
} from "../talk/audio-codec.js";
export { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../talk/agent-consult-tool.js";

export { canonicalizeBase64 } from "@openclaw/media-core/base64";
export { rawDataToString } from "../infra/ws.js";
export {
  coerceErrorMessage,
  extractErrorCode,
  readErrorName,
  toErrorObject,
  toStringifiedError,
} from "@openclaw/normalization-core/error-coercion";
export { sleepWithAbort } from "../infra/backoff.js";

export { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
export { buildRealtimeVoiceAgentControlSpeechMessage } from "../talk/agent-run-control-shared.js";
