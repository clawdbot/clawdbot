import { Writable } from "node:stream";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Progress tests cover CLI progress rendering and lifecycle cleanup.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { createCliProgress, shouldUseInteractiveProgressSpinner } from "./progress.js";

const clackMocks = vi.hoisted(() => {
  const spinnerInstance = {
    start: vi.fn(),
    message: vi.fn(),
    clear: vi.fn(),
  };
  return {
    spinner: vi.fn(() => spinnerInstance),
    spinnerInstance,
  };
});

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  spinner: clackMocks.spinner,
}));

function createOutput(
  isTTY: boolean,
  write: (chunk: string) => void = () => {},
  columns?: number,
): NodeJS.WriteStream {
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      write(chunk.toString());
      callback();
    },
  });
  Object.assign(output, { isTTY, columns });
  return output as NodeJS.WriteStream;
}

function withStdinIsRaw<T>(isRaw: boolean, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
  Object.defineProperty(process.stdin, "isRaw", {
    configurable: true,
    value: isRaw,
  });
  try {
    return run();
  } finally {
    if (original) {
      Object.defineProperty(process.stdin, "isRaw", original);
    } else {
      Reflect.deleteProperty(process.stdin, "isRaw");
    }
  }
}

describe("cli progress", () => {
  beforeEach(() => {
    clackMocks.spinner.mockClear();
    clackMocks.spinnerInstance.start.mockClear();
    clackMocks.spinnerInstance.message.mockClear();
    clackMocks.spinnerInstance.clear.mockClear();
  });

  it.each<[number, string]>([
    [32, "Checking channel status …"],
    [36, "Checking channel status (pro…"],
    [80, "Checking channel status (probe)…"],
  ])("bounds spinner at %i columns", (columns, expected) => {
    const stream = createOutput(true, undefined, columns);
    const progress = createCliProgress({ label: "Checking channel status (probe)…", stream });
    onTestFinished(() => progress.done());

    expect(clackMocks.spinnerInstance.start).toHaveBeenCalledWith(theme.accent(expected));
    progress.done();
    expect(stream.listenerCount("resize")).toBe(0);
  });

  it("suppresses animation below the frame budget", () => {
    const stream = createOutput(true, undefined, 6);
    const progress = createCliProgress({ label: "Loading", stream });
    onTestFinished(() => progress.done());

    expect(clackMocks.spinnerInstance.start).not.toHaveBeenCalled();
    progress.done();
    expect(stream.listenerCount("resize")).toBe(0);
  });

  it("logs progress when non-tty and fallback=log", () => {
    const writes: string[] = [];
    const stream = createOutput(
      false,
      vi.fn((chunk: string) => {
        writes.push(chunk);
      }),
    );

    const progress = createCliProgress({
      label: "Indexing memory...",
      total: 10,
      stream,
      fallback: "log",
    });
    progress.setPercent(50);
    progress.done();

    expect(writes).toEqual(["Indexing memory... 0%\n", "Indexing memory... 50%\n"]);
  });

  it("does not log without a tty when fallback is none", () => {
    const write = vi.fn();
    const stream = createOutput(false, write);

    const progress = createCliProgress({
      label: "Nope",
      total: 2,
      stream,
      fallback: "none",
    });
    progress.setPercent(50);
    progress.done();

    expect(write).not.toHaveBeenCalled();
  });

  it("does not render progress updates after the reporter is finished", () => {
    const writes: string[] = [];
    const stream = createOutput(
      false,
      vi.fn((chunk: string) => {
        writes.push(chunk);
      }),
    );

    const progress = createCliProgress({
      label: "Indexing memory...",
      total: 10,
      stream,
      fallback: "log",
    });
    progress.done();
    progress.setLabel("Late progress");
    progress.setPercent(50);
    progress.tick();

    expect(writes).toEqual(["Indexing memory... 0%\n"]);
  });

  it("does not stop an interactive spinner more than once", () => {
    const write = vi.fn();
    const stream = createOutput(true, write);
    const progress = createCliProgress({ label: "Loading", stream });
    progress.done();
    const completedWrites = write.mock.calls.length;
    expect(completedWrites).toBeGreaterThan(0);
    progress.done();

    expect(write).toHaveBeenCalledTimes(completedWrites);
  });

  it("does not let a finished reporter clear or unlock a newer progress line", () => {
    const firstStream = createOutput(true, vi.fn());
    const secondWrite = vi.fn();
    const secondStream = createOutput(true, secondWrite);
    const thirdWrite = vi.fn();
    const thirdStream = createOutput(true, thirdWrite);

    const first = createCliProgress({
      label: "First",
      stream: firstStream,
      fallback: "line",
    });
    first.done();

    const second = createCliProgress({
      label: "Second",
      stream: secondStream,
      fallback: "line",
    });
    try {
      secondWrite.mockClear();
      first.done();

      expect(secondWrite).not.toHaveBeenCalled();

      const third = createCliProgress({
        label: "Third",
        stream: thirdStream,
        fallback: "line",
      });
      third.done();

      expect(thirdWrite).not.toHaveBeenCalled();
    } finally {
      second.done();
    }
  });

  it("does not use readline-backed spinners while raw TUI input is active", () => {
    expect(
      shouldUseInteractiveProgressSpinner({
        streamIsTty: true,
        stdinIsRaw: true,
      }),
    ).toBe(false);
  });

  it("keeps the normal interactive spinner for regular tty commands", () => {
    expect(
      shouldUseInteractiveProgressSpinner({
        streamIsTty: true,
        stdinIsRaw: false,
      }),
    ).toBe(true);
  });

  it("routes clack spinner output through the progress stream", () => {
    const stream = createOutput(true, vi.fn());

    const progress = createCliProgress({
      label: "Loading",
      stream,
    });
    progress.done();

    expect(clackMocks.spinner).toHaveBeenCalledWith({ output: stream });
    expect(clackMocks.spinnerInstance.start).toHaveBeenCalledWith(
      expect.stringContaining("Loading"),
    );
  });

  it("does not write terminal controls when raw TUI input suppresses the default spinner", () => {
    const writes: string[] = [];
    const stream = createOutput(
      true,
      vi.fn((chunk: string) => {
        writes.push(chunk);
      }),
    );

    withStdinIsRaw(true, () => {
      const progress = createCliProgress({
        label: "Scanning",
        total: 2,
        stream,
      });
      progress.setLabel("Still scanning");
      progress.tick();
      progress.done();
    });

    expect(writes).toStrictEqual([]);
  });

  it("unregisters a delayed tty progress line when done before start", () => {
    const firstWrites: string[] = [];
    const firstStream = createOutput(
      true,
      vi.fn((chunk: string) => {
        firstWrites.push(chunk);
      }),
    );
    const secondStream = createOutput(true, vi.fn());

    const delayed = createCliProgress({
      label: "Delayed",
      stream: firstStream,
      fallback: "line",
      delayMs: 10_000,
    });
    delayed.done();

    const next = createCliProgress({
      label: "Next",
      stream: secondStream,
      fallback: "line",
    });
    next.done();

    expect(firstWrites).toStrictEqual([]);
  });

  it("clamps oversized delayed progress timers", () => {
    const stream = createOutput(true, vi.fn());
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const progress = createCliProgress({
        label: "Delayed",
        stream,
        fallback: "line",
        delayMs: Number.MAX_SAFE_INTEGER,
      });
      progress.done();

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
