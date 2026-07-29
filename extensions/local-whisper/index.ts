import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildLocalWhisperRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

export default definePluginEntry({
  id: "local-whisper",
  name: "Local Whisper Realtime Transcription",
  description: "Offline Norwegian transcription through a resident faster-whisper worker",
  register(api) {
    api.registerRealtimeTranscriptionProvider(buildLocalWhisperRealtimeTranscriptionProvider());
  },
});
