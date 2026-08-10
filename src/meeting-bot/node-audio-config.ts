import type { MeetingAudioBackendSelection, MeetingAudioRuntime } from "./audio-backend.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";

export type MeetingNodeAudioConfig = {
  backend: MeetingAudioBackendSelection;
  bufferBytes: number;
  format: MeetingRealtimeAudioFormat;
  inputCommand?: string[];
  outputCommand?: string[];
  bargeInInputCommand?: string[];
};

type MeetingNodeAudioPreparation = {
  defaultAudioInputCommand: readonly string[];
  defaultAudioOutputCommand: readonly string[];
  defaultAudio?: {
    backend?: MeetingAudioBackendSelection;
    bufferBytes: number;
    format: MeetingRealtimeAudioFormat;
  };
  assertAudioAvailable(timeoutMs: number): void | Promise<void>;
  prepareAudio?(config: MeetingNodeAudioConfig, timeoutMs: number): Promise<MeetingAudioRuntime>;
};

const DEFAULT_NODE_AUDIO_BUFFER_BYTES = 4_096;
const DEFAULT_NODE_AUDIO_FORMAT: MeetingRealtimeAudioFormat = "pcm16-24khz";

export function readMeetingNodeCommand(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return result.length > 0 ? result : undefined;
}

function readAudioBackend(value: unknown): MeetingAudioBackendSelection | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "auto" || value === "blackhole-2ch" || value === "pipewire-pulse") {
    return value;
  }
  throw new Error("audioBackend must be auto, blackhole-2ch, or pipewire-pulse");
}

function readAudioFormat(value: unknown): MeetingRealtimeAudioFormat | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "pcm16-24khz" || value === "g711-ulaw-8khz") {
    return value;
  }
  throw new Error("audioFormat must be pcm16-24khz or g711-ulaw-8khz");
}

function readAudioBufferBytes(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  throw new Error("audioBufferBytes must be a positive safe integer");
}

/** Resolves untrusted node params before any backend or command process starts. */
export async function prepareMeetingNodeAudio(
  params: Record<string, unknown>,
  timeoutMs: number,
  options: MeetingNodeAudioPreparation,
): Promise<MeetingAudioRuntime> {
  const defaults = options.defaultAudio;
  const config: MeetingNodeAudioConfig = {
    backend: readAudioBackend(params.audioBackend) ?? defaults?.backend ?? "auto",
    bufferBytes:
      readAudioBufferBytes(params.audioBufferBytes) ??
      defaults?.bufferBytes ??
      DEFAULT_NODE_AUDIO_BUFFER_BYTES,
    format: readAudioFormat(params.audioFormat) ?? defaults?.format ?? DEFAULT_NODE_AUDIO_FORMAT,
    inputCommand: readMeetingNodeCommand(params.audioInputCommand),
    outputCommand: readMeetingNodeCommand(params.audioOutputCommand),
    bargeInInputCommand: readMeetingNodeCommand(params.bargeInInputCommand),
  };
  if (options.prepareAudio) {
    return await options.prepareAudio(config, timeoutMs);
  }
  await options.assertAudioAvailable(timeoutMs);
  return {
    backend: "blackhole-2ch",
    deviceLabel: "BlackHole 2ch",
    inputCommand: config.inputCommand ?? [...options.defaultAudioInputCommand],
    outputCommand: config.outputCommand ?? [...options.defaultAudioOutputCommand],
  };
}
