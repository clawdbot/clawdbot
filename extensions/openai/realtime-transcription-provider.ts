import { openAIRealtimeHost } from "./realtime-host.js";
import { buildOpenAIRealtimeTranscriptionProvider as createProvider } from "./realtime-transcription-provider-factory.js";

export function buildOpenAIRealtimeTranscriptionProvider() {
  return createProvider(openAIRealtimeHost);
}
