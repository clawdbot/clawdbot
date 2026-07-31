import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";

export type MeetingRealtimeEngineConfig = {
  chrome: { audioFormat: MeetingRealtimeAudioFormat };
  realtime: {
    strategy: string;
    provider?: string;
    transcriptionProvider?: string;
    voiceProvider?: string;
    model?: string;
    instructions?: string;
    introMessage?: string;
    providers: Record<string, Record<string, unknown>>;
  };
};
