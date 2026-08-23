import { describe, expect, it, vi } from "vitest";
import { ensureMeetingAudioBackend, resolveMeetingAudioRuntimeForFormat } from "./audio-backend.js";

const PIPEWIRE_SINK_NAME = "openclaw_meeting_audio";
const PIPEWIRE_MONITOR_NAME = `${PIPEWIRE_SINK_NAME}.monitor`;
const PIPEWIRE_SOURCE_NAME = PIPEWIRE_SINK_NAME;

describe("meeting audio backend", () => {
  it("selects the native backend for macOS and Linux", () => {
    expect(
      resolveMeetingAudioRuntimeForFormat({
        backend: "auto",
        bufferBytes: 4_096,
        format: "pcm16-24khz",
        platform: "darwin",
      }).backend,
    ).toBe("blackhole-2ch");
    expect(
      resolveMeetingAudioRuntimeForFormat({
        backend: "auto",
        bufferBytes: 4_096,
        format: "pcm16-24khz",
        platform: "linux",
      }).backend,
    ).toBe("pipewire-pulse");
    expect(() =>
      resolveMeetingAudioRuntimeForFormat({
        backend: "auto",
        bufferBytes: 4_096,
        format: "pcm16-24khz",
        platform: "win32",
      }),
    ).toThrow("unsupported on win32");
  });

  it("builds PipeWire-Pulse raw command pairs", () => {
    const runtime = resolveMeetingAudioRuntimeForFormat({
      backend: "auto",
      bufferBytes: 4_096,
      format: "pcm16-24khz",
      platform: "linux",
    });
    expect(runtime).toMatchObject({
      backend: "pipewire-pulse",
      deviceLabel: "OpenClaw Meeting Audio",
    });
    expect(runtime.inputCommand).toEqual([
      "parec",
      "--raw",
      `--device=${PIPEWIRE_SOURCE_NAME}`,
      "--format=s16le",
      "--rate=24000",
      "--channels=1",
      "--latency-msec=86",
    ]);
    expect(runtime.outputCommand).toEqual([
      "pacat",
      "--raw",
      "--playback",
      `--device=${PIPEWIRE_SINK_NAME}`,
      "--format=s16le",
      "--rate=24000",
      "--channels=1",
      "--latency-msec=86",
    ]);
  });

  it("preserves explicit command overrides while resolving the host backend", () => {
    expect(
      resolveMeetingAudioRuntimeForFormat({
        backend: "auto",
        bufferBytes: 4_096,
        format: "pcm16-24khz",
        inputCommand: ["capture"],
        outputCommand: ["playback"],
        platform: "linux",
      }),
    ).toMatchObject({ inputCommand: ["capture"], outputCommand: ["playback"] });
  });

  it("idempotently provisions a PipeWire-Pulse null sink", async () => {
    const calls: string[][] = [];
    let sinkLoaded = false;
    let sourceLoaded = false;
    const run = vi.fn(async (argv: string[]) => {
      calls.push(argv);
      if (argv[1] === "info") {
        return { code: 0, stdout: "Server Name: PulseAudio (on PipeWire)" };
      }
      if (argv[1] === "load-module") {
        if (argv[2] === "module-null-sink") {
          sinkLoaded = true;
        } else if (argv[2] === "module-remap-source") {
          sourceLoaded = true;
        }
        return { code: 0, stdout: "17" };
      }
      if (argv[1] === "list") {
        const kind = argv[3];
        return {
          code: 0,
          stdout:
            kind === "sinks"
              ? sinkLoaded
                ? `42\t${PIPEWIRE_SINK_NAME}\tPipeWire\ts16le\tSUSPENDED`
                : ""
              : sourceLoaded
                ? `43\t${PIPEWIRE_SOURCE_NAME}\tPipeWire\ts16le\tSUSPENDED`
                : "",
        };
      }
      return { code: 0, stdout: "" };
    });

    await ensureMeetingAudioBackend({ backend: "pipewire-pulse", run, timeoutMs: 5_000 });

    expect(calls).toContainEqual([
      "pactl",
      "load-module",
      "module-null-sink",
      `sink_name=${PIPEWIRE_SINK_NAME}`,
      "rate=48000",
      "channels=2",
      "channel_map=front-left,front-right",
      `sink_properties='device.description="OpenClaw Meeting Audio"'`,
    ]);
    expect(calls).toContainEqual([
      "pactl",
      "load-module",
      "module-remap-source",
      `source_name=${PIPEWIRE_SOURCE_NAME}`,
      `master=${PIPEWIRE_MONITOR_NAME}`,
      "channels=2",
      "master_channel_map=front-left,front-right",
      "channel_map=front-left,front-right",
      "remix=no",
      `source_properties='device.description="OpenClaw Meeting Audio"'`,
    ]);
  });

  it("does not load a second module when the sink already exists", async () => {
    const run = vi.fn(async (argv: string[]) => {
      if (argv[1] === "info") {
        return { code: 0, stdout: "Server Name: PulseAudio (on PipeWire)" };
      }
      if (argv[1] === "list") {
        return {
          code: 0,
          stdout:
            argv[3] === "sinks"
              ? `42\t${PIPEWIRE_SINK_NAME}\tPipeWire`
              : `43\t${PIPEWIRE_SOURCE_NAME}\tPipeWire`,
        };
      }
      return { code: 0, stdout: "" };
    });

    await ensureMeetingAudioBackend({ backend: "pipewire-pulse", run, timeoutMs: 5_000 });

    expect(run.mock.calls.some(([argv]) => argv[1] === "load-module")).toBe(false);
  });
});
