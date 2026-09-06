import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { startFaceTimeAudioPump } from "../src/audio-pump.js";

class FakePipe extends Writable {
  writes: Buffer[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.writes.push(Buffer.from(chunk));
    callback();
  }
}

class FakeProcess extends EventEmitter {
  readonly pid = 1234;
  readonly stdin = new FakePipe();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  killed = false;

  kill(signal?: NodeJS.Signals) {
    this.kills.push(signal);
    this.killed = true;
    this.emit("exit", null, signal);
    return true;
  }
}

type TestSpawn = NonNullable<Parameters<typeof startFaceTimeAudioPump>[0]["spawn"]>;

function captureProcesses(processes: FakeProcess[]) {
  return vi.fn<TestSpawn>((_command, _args, _options) => {
    const process = new FakeProcess();
    processes.push(process);
    return process;
  });
}

function control(event: object): string {
  return `facetime-control:${JSON.stringify(event)}\n`;
}

describe("FaceTime native audio bridge", () => {
  it("publishes suppression and route readiness from assembled native lines", async () => {
    const processes: FakeProcess[] = [];
    const spawn = captureProcesses(processes);
    const onInputAudio = vi.fn();
    const pump = startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio,
      spawn,
    });

    expect(spawn.mock.calls[0]?.[0]).toBe("/capture");
    expect(spawn.mock.calls[0]?.[2]?.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(pump.processOutputSuppressed()).toBe(false);
    processes[0]?.stderr.emit("data", "facetime-audio-capture: started FaceTime process");
    expect(pump.processOutputSuppressed()).toBe(false);
    processes[0]?.stderr.emit("data", " tap\n");
    await pump.suppressionReady();
    expect(pump.processOutputSuppressed()).toBe(true);
    const route = pump.routeReady();
    processes[0]?.stderr.emit("data", "facetime-audio-capture: verified OpenClaw-Mic input");
    processes[0]?.stderr.emit("data", " route\n");
    await route;
    processes[0]?.stdout.emit("data", Buffer.from([1, 2]));
    expect(onInputAudio).toHaveBeenCalledWith(Buffer.from([1, 2]));
  });

  it("assembles fatal markers split across stderr chunks", () => {
    const processes: FakeProcess[] = [];
    const onError = vi.fn(async () => false);
    startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio() {},
      onError,
      spawn: captureProcesses(processes),
    });

    processes[0]?.stderr.emit("data", "facetime-audio-capture: fatal-safety");
    expect(onError).not.toHaveBeenCalled();
    processes[0]?.stderr.emit("data", "-retained: process tap failed\n");

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "native FaceTime safety monitor reported a fatal error",
      }),
    );
  });

  it("uses native played-frame and drain events instead of elapsed time", async () => {
    const processes: FakeProcess[] = [];
    const onPlaybackDrained = vi.fn();
    const pump = startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio() {},
      onPlaybackDrained,
      spawn: captureProcesses(processes),
    });

    pump.writeOutputAudio(Buffer.alloc(4_800));
    pump.finishOutputAudio();
    expect(pump.playedAudioFrames()).toBe(0);
    expect(pump.queuedAudioFrames()).toBe(2_400);
    processes[0]?.stderr.emit("data", control({ event: "played", generation: 1, frames: 1_200 }));
    expect(pump.playedAudioFrames()).toBe(1_200);
    expect(onPlaybackDrained).not.toHaveBeenCalled();
    processes[0]?.stderr.emit("data", control({ event: "drained", generation: 1, frames: 2_400 }));
    expect(pump.queuedAudioFrames()).toBe(0);
    expect(onPlaybackDrained).toHaveBeenCalledWith({ generation: 1, playedFrames: 2_400 });
  });

  it("invalidates stale drain callbacks when barge-in clears playback", () => {
    const processes: FakeProcess[] = [];
    const onPlaybackDrained = vi.fn();
    const pump = startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio() {},
      onPlaybackDrained,
      spawn: captureProcesses(processes),
    });
    pump.writeOutputAudio(Buffer.alloc(480));
    pump.clearOutputAudio();
    processes[0]?.stderr.emit("data", control({ event: "drained", generation: 1, frames: 240 }));
    expect(onPlaybackDrained).not.toHaveBeenCalled();
    expect(pump.queuedAudioFrames()).toBe(0);
  });

  it("reports capture-process death as immediate suppression loss", () => {
    const processes: FakeProcess[] = [];
    const onSuppressionLost = vi.fn();
    const pump = startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio() {},
      onError: vi.fn(async () => false),
      onSuppressionLost,
      spawn: captureProcesses(processes),
    });
    processes[0]?.stderr.emit("data", "facetime-audio-capture: started FaceTime process tap\n");
    processes[0]?.emit("exit", 1, null);
    expect(pump.processOutputSuppressed()).toBe(false);
    expect(onSuppressionLost).toHaveBeenCalledOnce();
  });

  it("uses parent EOF without a safe-release frame for process-handoff failure", async () => {
    const processes: FakeProcess[] = [];
    const pump = startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio() {},
      spawn: captureProcesses(processes),
    });

    const failClosed = pump.failClosed();
    expect(processes[0]?.stdin.writableEnded).toBe(true);
    expect(processes[0]?.stdin.writes).toEqual([]);
    processes[0]?.emit("exit", 0, null);
    await failClosed;
  });

  it("strips credential-shaped environment variables from native children", async () => {
    await withEnvAsync({ OPENAI_API_KEY: "secret", SAFE_VALUE: "yes" }, async () => {
      const processes: FakeProcess[] = [];
      const spawn = captureProcesses(processes);
      const pump = startFaceTimeAudioPump({
        captureBinary: "/capture",
        logger: console,
        onInputAudio() {},
        spawn,
      });

      expect(spawn.mock.calls[0]?.[2]?.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(spawn.mock.calls[0]?.[2]?.env).toHaveProperty("SAFE_VALUE", "yes");
      await pump.stop();
    });
  });
});
