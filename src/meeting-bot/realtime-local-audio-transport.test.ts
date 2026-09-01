import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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
    stderr: new PassThrough(),
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

function createTransportWith(
  overrides: Partial<Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]> = {},
) {
  return createLocalMeetingRealtimeAudioTransport({
    bargeInCooldownMs: 0,
    bargeInPeakThreshold: 0,
    bargeInRmsThreshold: 0,
    inputCommand: ["capture"],
    logger: { debug: vi.fn(), warn: vi.fn() } as never,
    logScope: "[meeting]",
    outputCommand: ["play"],
    ...overrides,
  });
}

function createTransport(outputStdin: TestStdin, replacementStdin = createStdin(true)) {
  const output = createProcess({ stdin: outputStdin });
  const input = createProcess({ stdout: new EventEmitter() });
  const replacementOutput = createProcess({ stdin: replacementStdin });
  const spawn = vi.fn().mockReturnValueOnce(output).mockReturnValueOnce(input);
  spawn.mockReturnValueOnce(replacementOutput);
  const transport = createTransportWith({ spawn: spawn as never });
  return { replacementOutput, spawn, transport };
}

describe("local meeting realtime audio transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["input", [], ["play"]],
    ["output", ["capture"], []],
  ] as const)("rejects an empty %s command before spawning", (_, inputCommand, outputCommand) => {
    const spawn = vi.fn();

    expect(() =>
      createTransportWith({
        inputCommand: [...inputCommand],
        outputCommand: [...outputCommand],
        spawn: spawn as never,
      }),
    ).toThrow("audio bridge command must not be empty");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps empty barge-in validation lazy until monitoring starts", async () => {
    const output = createProcess({ stdin: createStdin(true) });
    const input = createProcess({ stdout: new EventEmitter() });
    const spawn = vi.fn().mockReturnValueOnce(output).mockReturnValueOnce(input);
    const transport = createTransportWith({
      bargeInInputCommand: [],
      spawn: spawn as never,
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(() => transport.startBargeInMonitor?.(() => false)).toThrow(
      "audio bridge command must not be empty",
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    await transport.stop();
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

  it("preserves split UTF-8 diagnostics and logs complete fragments immediately", async () => {
    const processes = new Map<string, ReturnType<typeof createProcess>>();
    const debug = vi.fn();
    const spawn = vi.fn((command: string) => {
      const proc = createProcess({});
      processes.set(command, proc);
      return proc;
    });
    const transport = createTransportWith({
      inputCommand: ["capture", "--device", "input name", ""],
      logger: { debug, warn: vi.fn() } as never,
      outputCommand: ["play", "--device", "output name", ""],
      bargeInInputCommand: ["barge", "--device", "barge name", ""],
      spawn: spawn as never,
    });
    transport.startBargeInMonitor?.(() => false);

    expect(spawn).toHaveBeenNthCalledWith(1, "play", ["--device", "output name", ""], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    expect(spawn).toHaveBeenNthCalledWith(2, "capture", ["--device", "input name", ""], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(spawn).toHaveBeenNthCalledWith(3, "barge", ["--device", "barge name", ""], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    for (const [command, label] of [
      ["play", "audio output"],
      ["capture", "audio input"],
      ["barge", "barge-in input"],
    ] as const) {
      const process = processes.get(command);
      if (!process) {
        throw new Error(`Expected ${command} process`);
      }
      const diagnostic = `诊断-${command}`;
      const line = Buffer.from(`${diagnostic}\n`, "utf8");
      const before = debug.mock.calls.length;
      process.stderr.write(line.subarray(0, 2));
      expect(debug).toHaveBeenCalledTimes(before);
      process.stderr.write(line.subarray(2, -1));
      expect(debug).toHaveBeenNthCalledWith(before + 1, `[meeting] ${label}: ${diagnostic}`);
      process.stderr.write(line.subarray(-1));

      process.stderr.write(Buffer.from(`未换行-${command}`, "utf8"));
      expect(debug).toHaveBeenNthCalledWith(before + 2, `[meeting] ${label}: 未换行-${command}`);
    }

    await transport.stop();
  });
});
