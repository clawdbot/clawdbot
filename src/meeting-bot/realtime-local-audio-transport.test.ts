import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalMeetingRealtimeAudioTransport } from "./realtime-local-audio-transport.js";

type TestStdin = EventEmitter & {
  write: ReturnType<typeof vi.fn>;
};

function createStdin(writeResult: boolean): TestStdin {
  const stdin = new EventEmitter() as TestStdin;
  const callbacks: Array<(error?: Error | null) => void> = [];
  stdin.write = vi.fn((_audio: Buffer, callback?: (error?: Error | null) => void) => {
    if (callback) {
      if (writeResult) {
        queueMicrotask(() => callback());
      } else {
        callbacks.push(callback);
      }
    }
    return writeResult;
  });
  stdin.on("drain", () => {
    for (const callback of callbacks.splice(0)) {
      callback();
    }
  });
  return stdin;
}

function createProcess(params: { stdin?: TestStdin | null; stdout?: EventEmitter | null }) {
  const events = new EventEmitter();
  const proc = {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: params.stdin ?? null,
    stdout: params.stdout ?? null,
    stderr: new EventEmitter(),
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      proc.signalCode = signal;
      queueMicrotask(() => {
        proc.stdin?.emit("close");
        events.emit("exit", null, signal);
      });
      return true;
    }),
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
  };
  return proc;
}

function createTransport(outputStdin: TestStdin, replacementStdin = createStdin(true)) {
  const output = createProcess({ stdin: outputStdin });
  const input = createProcess({ stdout: new EventEmitter() });
  const replacementOutput = createProcess({ stdin: replacementStdin });
  const spawn = vi.fn().mockReturnValueOnce(output).mockReturnValueOnce(input);
  spawn.mockReturnValueOnce(replacementOutput);
  const transport = createLocalMeetingRealtimeAudioTransport({
    bargeInCooldownMs: 0,
    bargeInPeakThreshold: 0,
    bargeInRmsThreshold: 0,
    inputCommand: ["capture"],
    logger: { debug: vi.fn(), warn: vi.fn() } as never,
    logScope: "[meeting]",
    outputCommand: ["play"],
    spawn: spawn as never,
  });
  return { replacementOutput, spawn, transport };
}

describe("local meeting realtime audio transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for output drain after the child stream backpressures", async () => {
    const outputStdin = createStdin(false);
    const { transport } = createTransport(outputStdin);
    let settled = false;

    const writing = transport.writeOutput(Buffer.from([1, 2, 3])).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    outputStdin.emit("drain");
    await writing;
    expect(settled).toBe(true);

    await transport.stop();
  });

  it("releases a backpressured write when clear replaces its output process", async () => {
    const outputStdin = createStdin(false);
    const { replacementOutput, transport } = createTransport(outputStdin);
    let settled = false;

    const writing = transport.writeOutput(Buffer.from([4, 5, 6])).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await transport.clearOutput();
    await writing;

    expect(settled).toBe(true);
    expect(replacementOutput.stdin?.write).not.toHaveBeenCalled();
    await transport.stop();
  });
});
