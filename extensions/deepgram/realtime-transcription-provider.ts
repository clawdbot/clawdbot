import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { buildDeepgramRealtimeTranscriptionProvider as createProvider } from "./realtime-transcription-provider-factory.js";

export function buildDeepgramRealtimeTranscriptionProvider() {
  return createProvider({ createRealtimeTranscriptionWebSocketSession });
}
