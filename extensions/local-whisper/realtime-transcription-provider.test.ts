import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";
import { mulaw8KhzToPcm16Khz } from "./audio.js";
import { buildLocalWhisperRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { createLocalWhisperRealtimeTranscriptionSession } from "./session.js";
import type {
  LocalWhisperWorker,
  LocalWhisperWorkerEvent,
  LocalWhisperWorkerFactory,
} from "./worker.js";
import { spawnLocalWhisperWorker } from "./worker.js";

const TEST_PYTHON = process.env.LOCAL_WHISPER_PYTHON ?? process.env.PYTHON ?? "python3";

class MockWorker implements LocalWhisperWorker {
  readonly pid = 4242;
  readonly audio: Buffer[] = [];
  ended = false;
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

  endAudio(): void {
    this.ended = true;
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
    maxUtteranceMs: 30_000,
    pythonPath: process.execPath,
    workerScript: "/tmp/worker.py",
    workerFactory,
    ...callbacks,
  });
  return { session, worker, workerFactory };
}

function runWorkerPython(assertions: string): void {
  const script = `
import argparse
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("local_whisper_worker", ${JSON.stringify(
    join(import.meta.dirname, "worker.py"),
  )})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class Vad:
    def is_speech(self, frame, _rate):
        return frame[0] == 1

def make_worker(max_ms=30000):
    args = argparse.Namespace(
        model="small", device="cpu", compute_type="int8", language="no",
        vad_aggressiveness=2, silence_ms=700, max_utterance_ms=max_ms,
    )
    worker = module.Worker(args)
    worker.vad = Vad()
    captured = []
    worker.transcribe = captured.append
    return worker, captured

frame = lambda value: bytes([value]) * module.FRAME_BYTES
${assertions}
`;
  execFileSync(TEST_PYTHON, ["-c", script], { stdio: "pipe" });
}

describe("local-whisper audio", () => {
  it("converts a 20 ms silence fixture to 16 kHz PCM16", () => {
    const output = mulaw8KhzToPcm16Khz(Buffer.alloc(160, 0xff));
    expect(output).toHaveLength(640);
    expect(output.equals(Buffer.alloc(640))).toBe(true);
  });

  it("decodes and resamples canonical µ-law signal values", () => {
    const output = mulaw8KhzToPcm16Khz(Buffer.from([0xff, 0x80]));
    expect(output).toHaveLength(8);
    expect(
      Array.from({ length: output.length / 2 }, (_, index) => output.readInt16LE(index * 2)),
    ).toEqual([0, 16_062, 32_124, 32_124]);
  });
});

describe("local-whisper provider", () => {
  it("resolves nested config with offline Norwegian defaults", () => {
    const provider = buildLocalWhisperRealtimeTranscriptionProvider();
    const config = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          "local-whisper": {
            model: "base",
            silenceMs: "900",
            vadAggressiveness: 3,
          },
        },
      },
    });
    expect(config).toMatchObject({
      model: "base",
      language: "no",
      device: "cpu",
      computeType: "int8",
      silenceMs: 900,
      vadAggressiveness: 3,
      maxUtteranceMs: 30_000,
      pythonPath: undefined,
    });
  });

  it("is configured with the bundled worker and an explicit Python executable", () => {
    const provider = buildLocalWhisperRealtimeTranscriptionProvider();
    const config = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: { pythonPath: process.execPath },
    });
    expect(config).toBeDefined();
    expect(provider.isConfigured({ providerConfig: config! })).toBe(true);
  });

  it("is not configured without an explicit Python executable", () => {
    const provider = buildLocalWhisperRealtimeTranscriptionProvider();
    const previous = process.env.LOCAL_WHISPER_PYTHON;
    delete process.env.LOCAL_WHISPER_PYTHON;
    try {
      const config = provider.resolveConfig?.({
        cfg: {} as OpenClawConfig,
        rawConfig: { model: "small" },
      });
      expect(config).toBeDefined();
      expect(provider.isConfigured({ providerConfig: config! })).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.LOCAL_WHISPER_PYTHON;
      } else {
        process.env.LOCAL_WHISPER_PYTHON = previous;
      }
    }
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
  it("waits for ready, converts audio, and forwards final callbacks", async () => {
    const onSpeechStart = vi.fn();
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const { session, worker } = mockSession({ onSpeechStart, onTranscript, onError });
    const connecting = session.connect();
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
    expect(worker.ended).toBe(true);
    expect(worker.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(worker.killed).toBe(true);
    vi.useRealTimers();
  });
});

describe("local-whisper worker hardening", () => {
  it("keeps 300 ms of pre-roll before speech", () => {
    runWorkerPython(`
worker, captured = make_worker()
worker.feed(frame(0) * 7 + frame(1) * 10 + frame(0) * 24)
assert len(captured) == 1
assert captured[0].startswith(frame(0) * 7)
assert frame(1) * 10 in captured[0]
`);
  });

  it("forces a transcript at the maximum utterance duration", () => {
    runWorkerPython(`
worker, captured = make_worker(30000)
worker.feed(frame(1) * (35000 // module.FRAME_MS))
assert captured
assert len(captured[0]) == 30000 * module.SAMPLE_RATE * 2 // 1000
`);
  });

  it("treats worker stderr as diagnostics rather than a structured error event", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-whisper-stderr-"));
    const workerScript = join(directory, "worker.py");
    writeFileSync(
      workerScript,
      [
        "import json, os, sys",
        'print(json.dumps({"event":"ready","pid":os.getpid(),"model":"test"}), flush=True)',
        'print("warning: foo", file=sys.stderr, flush=True)',
        "sys.stdin.buffer.read()",
      ].join("\n"),
    );
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      const worker = spawnLocalWhisperWorker({
        pythonPath: TEST_PYTHON,
        workerScript,
        model: "test",
        language: "no",
        device: "cpu",
        computeType: "int8",
        silenceMs: 700,
        vadAggressiveness: 2,
        maxUtteranceMs: 30_000,
      });
      const events: LocalWhisperWorkerEvent[] = [];
      await new Promise<void>((resolve) => {
        worker.onEvent((event) => {
          events.push(event);
          if (event.event === "ready") {
            worker.endAudio();
          }
        });
        worker.onExit(() => resolve());
      });
      expect(events.some((event) => event.event === "error")).toBe(false);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining("warning: foo"));
    } finally {
      debug.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
