import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { elevenLabsMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildElevenLabsRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildElevenLabsSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "elevenlabs",
  name: "ElevenLabs Speech",
  description: "Bundled ElevenLabs speech provider",
  register(api) {
    api.registerSpeechProvider(buildElevenLabsSpeechProvider());
    api.registerMediaUnderstandingProvider(elevenLabsMediaUnderstandingProvider);
    api.registerRealtimeTranscriptionProvider(buildElevenLabsRealtimeTranscriptionProvider());
  },
});
