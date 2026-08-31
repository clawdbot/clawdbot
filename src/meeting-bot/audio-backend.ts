import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";
import { buildMeetingSoxAudioCommands } from "./sox-audio-command.js";

export type MeetingAudioBackend = "blackhole-2ch" | "pipewire-pulse";
export type MeetingAudioBackendSelection = "auto" | MeetingAudioBackend;

type MeetingAudioCommandConfig = {
  backend?: MeetingAudioBackendSelection;
  bufferBytes: number;
  format: {
    sampleRate: number;
    channels: number;
    encoding: string;
    bits: number;
    endian?: "little" | "big";
  };
  inputCommand?: readonly string[];
  outputCommand?: readonly string[];
};

export type MeetingAudioRuntime = {
  backend: MeetingAudioBackend;
  deviceLabel: string;
  inputCommand: string[];
  outputCommand: string[];
};

export type MeetingAudioCommandResult = {
  code: number;
  stdout?: string;
  stderr?: string;
};

const PIPEWIRE_SINK_NAME = "openclaw_meeting_audio";
const PIPEWIRE_MONITOR_NAME = `${PIPEWIRE_SINK_NAME}.monitor`;
const PIPEWIRE_SOURCE_NAME = PIPEWIRE_SINK_NAME;
const PIPEWIRE_MEETING_AUDIO_DEVICE_LABEL = "OpenClaw Meeting Audio";
const BLACKHOLE_MEETING_AUDIO_DEVICE_LABEL = "BlackHole 2ch";

function resolvePulseFormat(config: MeetingAudioCommandConfig["format"]): string {
  if (config.encoding === "mu-law" && config.bits === 8) {
    return "ulaw";
  }
  if (config.encoding === "signed-integer" && config.bits === 16) {
    return config.endian === "big" ? "s16be" : "s16le";
  }
  throw new Error(
    `PipeWire-Pulse does not support meeting audio format ${config.encoding}/${config.bits}.`,
  );
}

function resolveMeetingAudioBackend(
  selection: MeetingAudioBackendSelection | undefined,
  platform: NodeJS.Platform = process.platform,
): MeetingAudioBackend {
  if (selection && selection !== "auto") {
    if (selection === "blackhole-2ch" && platform !== "darwin") {
      throw new Error("BlackHole 2ch meeting audio requires macOS.");
    }
    if (selection === "pipewire-pulse" && platform !== "linux") {
      throw new Error("PipeWire-Pulse meeting audio requires Linux.");
    }
    return selection;
  }
  if (platform === "darwin") {
    return "blackhole-2ch";
  }
  if (platform === "linux") {
    return "pipewire-pulse";
  }
  throw new Error(
    `Local Chrome meeting talk-back is unsupported on ${platform}; use transcribe mode or a macOS/Linux Chrome node.`,
  );
}

function resolveMeetingAudioRuntime(
  config: MeetingAudioCommandConfig,
  platform: NodeJS.Platform = process.platform,
): MeetingAudioRuntime {
  const backend = resolveMeetingAudioBackend(config.backend, platform);
  const bytesPerSecond =
    config.format.sampleRate * config.format.channels * Math.ceil(config.format.bits / 8);
  const pulseLatencyMs = Math.max(1, Math.ceil((config.bufferBytes / bytesPerSecond) * 1_000));
  const defaults =
    backend === "blackhole-2ch"
      ? buildMeetingSoxAudioCommands({
          bufferBytes: config.bufferBytes,
          device: BLACKHOLE_MEETING_AUDIO_DEVICE_LABEL,
          deviceType: "coreaudio",
          format: config.format,
        })
      : {
          inputCommand: [
            "parec",
            "--raw",
            `--device=${PIPEWIRE_SOURCE_NAME}`,
            `--format=${resolvePulseFormat(config.format)}`,
            `--rate=${config.format.sampleRate}`,
            `--channels=${config.format.channels}`,
            `--latency-msec=${pulseLatencyMs}`,
          ],
          outputCommand: [
            "pacat",
            "--raw",
            "--playback",
            `--device=${PIPEWIRE_SINK_NAME}`,
            `--format=${resolvePulseFormat(config.format)}`,
            `--rate=${config.format.sampleRate}`,
            `--channels=${config.format.channels}`,
            `--latency-msec=${pulseLatencyMs}`,
          ],
        };
  return {
    backend,
    deviceLabel:
      backend === "blackhole-2ch"
        ? BLACKHOLE_MEETING_AUDIO_DEVICE_LABEL
        : PIPEWIRE_MEETING_AUDIO_DEVICE_LABEL,
    inputCommand: config.inputCommand ? [...config.inputCommand] : defaults.inputCommand,
    outputCommand: config.outputCommand ? [...config.outputCommand] : defaults.outputCommand,
  };
}

export function resolveMeetingAudioRuntimeForFormat(params: {
  backend?: MeetingAudioBackendSelection;
  bufferBytes: number;
  format: MeetingRealtimeAudioFormat;
  inputCommand?: readonly string[];
  outputCommand?: readonly string[];
  platform?: NodeJS.Platform;
}): MeetingAudioRuntime {
  return resolveMeetingAudioRuntime(
    {
      backend: params.backend,
      bufferBytes: params.bufferBytes,
      format:
        params.format === "g711-ulaw-8khz"
          ? { sampleRate: 8_000, channels: 1, encoding: "mu-law", bits: 8 }
          : {
              sampleRate: 24_000,
              channels: 1,
              encoding: "signed-integer",
              bits: 16,
              endian: "little",
            },
      inputCommand: params.inputCommand,
      outputCommand: params.outputCommand,
    },
    params.platform,
  );
}

function commandOutput(result: MeetingAudioCommandResult): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function pulseListContains(output: string, name: string): boolean {
  return output.split(/\r?\n/u).some((line) => line.split(/\s+/u)[1] === name);
}

function assertCommandSucceeded(result: MeetingAudioCommandResult, message: string): void {
  if (result.code === 0) {
    return;
  }
  const detail = commandOutput(result).trim();
  throw new Error(detail ? `${message}: ${detail}` : message);
}

export async function ensureMeetingAudioBackend(params: {
  backend: MeetingAudioBackend;
  run(argv: string[], timeoutMs: number): Promise<MeetingAudioCommandResult>;
  timeoutMs: number;
}): Promise<void> {
  if (params.backend === "blackhole-2ch") {
    const result = await params.run(
      ["/usr/sbin/system_profiler", "SPAudioDataType"],
      params.timeoutMs,
    );
    if (result.code !== 0 || !commandOutput(result).toLowerCase().includes("blackhole 2ch")) {
      throw new Error(
        "BlackHole 2ch audio device not found. Install BlackHole 2ch and SoX, then reboot.",
      );
    }
    return;
  }

  const info = await params.run(["pactl", "info"], params.timeoutMs);
  assertCommandSucceeded(
    info,
    "PipeWire-Pulse is unavailable. Start pipewire-pulse and install pulseaudio-utils",
  );
  let sinks = await params.run(["pactl", "list", "short", "sinks"], params.timeoutMs);
  if (!pulseListContains(sinks.stdout ?? "", PIPEWIRE_SINK_NAME)) {
    const loaded = await params.run(
      [
        "pactl",
        "load-module",
        "module-null-sink",
        `sink_name=${PIPEWIRE_SINK_NAME}`,
        "rate=48000",
        "channels=2",
        "channel_map=front-left,front-right",
        `sink_properties='device.description="${PIPEWIRE_MEETING_AUDIO_DEVICE_LABEL}"'`,
      ],
      params.timeoutMs,
    );
    if (loaded.code !== 0) {
      sinks = await params.run(["pactl", "list", "short", "sinks"], params.timeoutMs);
      if (!pulseListContains(sinks.stdout ?? "", PIPEWIRE_SINK_NAME)) {
        assertCommandSucceeded(loaded, "Could not create the OpenClaw PipeWire-Pulse sink");
      }
    }
  }
  let sources = await params.run(["pactl", "list", "short", "sources"], params.timeoutMs);
  if (!pulseListContains(sources.stdout ?? "", PIPEWIRE_SOURCE_NAME)) {
    const loaded = await params.run(
      [
        "pactl",
        "load-module",
        "module-remap-source",
        `source_name=${PIPEWIRE_SOURCE_NAME}`,
        `master=${PIPEWIRE_MONITOR_NAME}`,
        "channels=2",
        "master_channel_map=front-left,front-right",
        "channel_map=front-left,front-right",
        "remix=no",
        `source_properties='device.description="${PIPEWIRE_MEETING_AUDIO_DEVICE_LABEL}"'`,
      ],
      params.timeoutMs,
    );
    if (loaded.code !== 0) {
      sources = await params.run(["pactl", "list", "short", "sources"], params.timeoutMs);
      if (!pulseListContains(sources.stdout ?? "", PIPEWIRE_SOURCE_NAME)) {
        assertCommandSucceeded(loaded, "Could not create the OpenClaw PipeWire-Pulse source");
      }
    }
  }
  sinks = await params.run(["pactl", "list", "short", "sinks"], params.timeoutMs);
  sources = await params.run(["pactl", "list", "short", "sources"], params.timeoutMs);
  if (
    !pulseListContains(sinks.stdout ?? "", PIPEWIRE_SINK_NAME) ||
    !pulseListContains(sources.stdout ?? "", PIPEWIRE_SOURCE_NAME)
  ) {
    throw new Error("OpenClaw PipeWire-Pulse sink or monitor source was not created.");
  }
}
