import { openAIRealtimeHost } from "./realtime-host.js";
import { buildOpenAIRealtimeVoiceProvider as createProvider } from "./realtime-voice-provider-factory.js";

export function buildOpenAIRealtimeVoiceProvider(options?: Parameters<typeof createProvider>[1]) {
  return createProvider(openAIRealtimeHost, options);
}
