import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { buildElevenLabsRealtimeTranscriptionProvider as createProvider } from "./realtime-transcription-provider-factory.js";

export function buildElevenLabsRealtimeTranscriptionProvider() {
  return createProvider({ createRealtimeTranscriptionWebSocketSession });
}
