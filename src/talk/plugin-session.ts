import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceAudioFormat,
} from "./provider-types.js";

export const PLUGIN_TALK_AUDIO_FORMAT: Readonly<
  Extract<RealtimeVoiceAudioFormat, { encoding: "pcm16" }>
> = REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;

export type PluginTalkSessionEvent =
  | {
      type: "state";
      generation: number;
      ptsMs: number;
      state: "idle" | "listening" | "thinking" | "speaking" | "error";
    }
  | {
      type: "audio";
      generation: number;
      sequence: number;
      ptsMs: number;
      pcm: Uint8Array;
    }
  | {
      type: "clear";
      generation: number;
      reason: "barge-in" | "cancel";
    }
  | {
      type: "closed";
      generation: number;
      reason: "completed" | "error";
    };

export type OpenPluginTalkSessionParams = {
  sessionKey: string;
  signal: AbortSignal;
  provider?: string;
  model?: string;
  voice?: string;
  language?: string;
  onEvent: (event: PluginTalkSessionEvent) => void | Promise<void>;
};

export type PluginTalkSession = {
  readonly audio: typeof PLUGIN_TALK_AUDIO_FORMAT;
  sendAudio(pcm: Uint8Array, options?: { timestamp?: number }): void;
  cancelOutput(reason?: string): void;
  close(): void;
};
