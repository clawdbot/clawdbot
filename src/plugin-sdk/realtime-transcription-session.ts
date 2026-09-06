/** Session construction for provider descriptors without importing the host provider registry. */
export type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
export type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderConfiguredContext,
  RealtimeTranscriptionProviderId,
  RealtimeTranscriptionProviderResolveConfigContext,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCallbacks,
  RealtimeTranscriptionSessionCreateRequest,
} from "../realtime-transcription/provider-types.js";
export {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionWebSocketSessionOptions,
  type RealtimeTranscriptionWebSocketTransport,
} from "../realtime-transcription/websocket-session.js";
