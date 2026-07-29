import { EventEmitter } from "node:events";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";
import { decodeMulawSample, mulaw8KhzToPcm16Khz, mulawToPcm16, resamplePcm16 } from "./audio.js";
import {
  buildLocalWhisperRealtimeTranscriptionProvider,
  resolveLocalWhisperConfig,
} from "./realtime-transcription-provider.js";
import { createLocalWhisperRealtimeTranscriptionSession } from "./session.js";
import type {
  LocalWhisperWorker,
  LocalWhisperWorkerEvent,
  LocalWhisperWorkerFactory,
} from "./worker.js";

class MockWorker implements LocalWhisperWorker {
  readonly pid = 4242;
  readonly audio: Buffer[] = [];
  readonly commands: string[] = [];
  killed = false;
  private readonly events = new EventEmitter();

  onEvent(listener: (event: LocalWhisperWorkerEvent) => void): void {
    this.events.on("event", listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.events.on("exit", listener);
  }

  writeAudio(audio: Buffer): void {
    this.audio.push(Buffer.from(audio));
  }

  command(command: "reset" | "shutdown"): void {
    this.commands.push(command);
  }

  kill(): void {
    this.killed = true;
  }

  emit(event: LocalWhisperWorkerEvent): void {
    this.events.emit("event", event);
  }

  exit(code = 0): void {
    this.events.emit("exit", code, null);
  }
}

function mockSession(
  callbacks: {
    onSpeechStart?: () => void;
    onTranscript?: (text: string) => void;
    onError?: (error: Error) => void;
  } = {},
) {
  const worker = new MockWorker();
  const workerFactory = vi.fn(() => worker) as LocalWhisperWorkerFactory;
  const session = createLocalWhisperRealtimeTranscriptionSession({
    model: "small",
    language: "no",
    device: "cpu",
    computeType: "int8",
    silenceMs: 700,
    vadAggressiveness: 2,
    pythonPath: "python3",
    workerScript: "/tmp/worker.py",
    workerFactory,
    ...callbacks,
  });
  return { session, worker, workerFactory };
}

describe("local-whisper audio", () => {
  it("decodes the canonical G.711 µ-law values", () => {
    expect(decodeMulawSample(0xff)).toBe(0);
    expect(decodeMulawSample(0x7f)).toBe(0);
    expect(decodeMulawSample(0x00)).toBe(-32124);
    expect(decodeMulawSample(0x80)).toBe(32124);
    expect([...mulawToPcm16(Buffer.from([0xff, 0x80]))]).toEqual([0, 0, 124, 125]);
  });

  it("resamples 8 kHz PCM16 to exactly twice the samples at 16 kHz", () => {
    const pcm = Buffer.alloc(6);
    pcm.writeInt16LE(0, 0);
    pcm.writeInt16LE(1_000, 2);
    pcm.writeInt16LE(2_000, 4);
    const output = resamplePcm16(pcm);
    expect(output.length).toBe(12);
    expect(
      Array.from({ length: output.length / 2 }, (_, index) => output.readInt16LE(index * 2)),
    ).toEqual([0, 500, 1_000, 1_500, 2_000, 2_000]);
  });

  it("converts a 20 ms 8 kHz µ-law fixture into 20 ms 16 kHz PCM16", () => {
    const fixture = Buffer.alloc(160, 0xff);
    const output = mulaw8KhzToPcm16Khz(fixture);
    expect(output).toHaveLength(640);
    expect(output.equals(Buffer.alloc(640))).toBe(true);
  });
});

describe("local-whisper provider", () => {
  it("resolves nested config with offline Norwegian defaults", () => {
    expect(
      resolveLocalWhisperConfig({
        providers: {
          "local-whisper": {
            model: "base",
            silenceMs: "900",
            vadAggressiveness: 3,
          },
        },
      }),
    ).toMatchObject({
      model: "base",
      language: "no",
      device: "cpu",
      computeType: "int8",
      silenceMs: 900,
      vadAggressiveness: 3,
      pythonPath: "python3",
    });
  });

  it("is configured with the checked-in worker and an explicit Python executable", () => {
    const provider = buildLocalWhisperRealtimeTranscriptionProvider();
    const config = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: { pythonPath: process.execPath },
    });
    expect(config).toBeDefined();
    expect(provider.isConfigured({ providerConfig: config! })).toBe(true);
  });

  it("does not make outbound requests while resolving config or creating a session", () => {
    const originalDispatcher = getGlobalDispatcher();
    const network = new MockAgent();
    network.disableNetConnect();
    setGlobalDispatcher(network);
    try {
      const provider = buildLocalWhisperRealtimeTranscriptionProvider();
      const session = provider.createSession({
        providerConfig: {
          pythonPath: process.execPath,
          workerScript: "/tmp/not-started-in-this-test.py",
        },
      });
      expect(session.isConnected()).toBe(false);
      expect(network.pendingInterceptors()).toEqual([]);
    } finally {
      setGlobalDispatcher(originalDispatcher);
      void network.close();
    }
  });
});

describe("local-whisper session", () => {
  it("waits for ready, converts audio, and forwards final callbacks without partials", async () => {
    const onSpeechStart = vi.fn();
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const { session, worker } = mockSession({ onSpeechStart, onTranscript, onError });
    const connecting = session.connect();
    expect(session.isConnected()).toBe(false);
    worker.emit({ event: "ready", pid: worker.pid!, model: "small" });
    await connecting;

    session.sendAudio(Buffer.alloc(160, 0xff));
    worker.emit({ event: "speech_start" });
    worker.emit({ event: "transcript", text: "  hei Oddmund  ", segments: [] });

    expect(session.isConnected()).toBe(true);
    expect(worker.audio).toHaveLength(1);
    expect(worker.audio[0]).toHaveLength(640);
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("hei Oddmund");
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps one resident worker PID across two speech turns", async () => {
    const transcripts: string[] = [];
    const { session, worker, workerFactory } = mockSession({
      onTranscript: (text) => transcripts.push(text),
    });
    const connecting = session.connect();
    worker.emit({ event: "ready", pid: worker.pid!, model: "small" });
    await connecting;

    for (const text of ["første tur", "andre tur"]) {
      session.sendAudio(Buffer.alloc(160, 0xff));
      worker.emit({ event: "speech_start" });
      worker.emit({ event: "transcript", text });
    }

    expect(workerFactory).toHaveBeenCalledOnce();
    expect(worker.pid).toBe(4242);
    expect(transcripts).toEqual(["første tur", "andre tur"]);
  });

  it("requests graceful shutdown and kills only after the timeout", async () => {
    vi.useFakeTimers();
    const { session, worker } = mockSession();
    const connecting = session.connect();
    worker.emit({ event: "ready", pid: worker.pid!, model: "small" });
    await connecting;
    session.close();
    expect(worker.commands).toEqual(["shutdown"]);
    expect(worker.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(worker.killed).toBe(true);
    vi.useRealTimers();
  });
});
