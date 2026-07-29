// Progress tests cover CLI progress rendering and lifecycle cleanup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { createCliProgress, shouldUseInteractiveProgressSpinner } from "./progress.js";

const clackMocks = vi.hoisted(() => {
  const spinnerInstance = {
    start: vi.fn(),
    message: vi.fn(),
    stop: vi.fn(),
  };
  return {
    spinner: vi.fn(() => spinnerInstance),
    spinnerInstance,
  };
});

vi.mock("@clack/prompts", () => ({
  spinner: clackMocks.spinner,
}));

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
    clackMocks.spinnerInstance.stop.mockClear();
  });

  it("logs progress when non-tty and fallback=log", () => {
    const writes: string[] = [];
    const stream = {
      isTTY: false,
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
      }),
    } as unknown as NodeJS.WriteStream;

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
    const stream = {
      isTTY: false,
      write,
    } as unknown as NodeJS.WriteStream;

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

  it("does not use readline-backed spinners while raw TUI input is active", () => {
    expect(
      shouldUseInteractiveProgressSpinner({
        streamIsTty: true,
        stdinIsRaw: true,
      }),
    ).toBe(false);
  });

  it("uses the progress stream instead of stdout to decide spinner interactivity", () => {
    expect(
      shouldUseInteractiveProgressSpinner({
        streamIsTty: true,
        stdinIsRaw: false,
      }),
    ).toBe(true);
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
    const stream = {
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    const progress = createCliProgress({
      label: "Loading",
      stream,
    });
    progress.done();

    expect(clackMocks.spinner).toHaveBeenCalledWith({ output: stream });
    expect(clackMocks.spinnerInstance.start).toHaveBeenCalledWith(
      expect.stringContaining("Loading"),
    );
    expect(clackMocks.spinnerInstance.stop).toHaveBeenCalledTimes(1);
  });

  it("does not write terminal controls when raw TUI input suppresses the default spinner", () => {
    const writes: string[] = [];
    const stream = {
      isTTY: true,
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
      }),
    } as unknown as NodeJS.WriteStream;

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
    const firstStream = {
      isTTY: true,
      write: vi.fn((chunk: string) => {
        firstWrites.push(chunk);
      }),
    } as unknown as NodeJS.WriteStream;
    const secondStream = {
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

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
    const stream = {
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;
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
