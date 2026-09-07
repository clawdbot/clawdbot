import { EventEmitter } from "node:events";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Progress tests cover CLI progress rendering and lifecycle cleanup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi, visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import { createCliProgress, shouldUseInteractiveProgressSpinner } from "./progress.js";

const clackMocks = vi.hoisted(() => {
  const spinnerInstance = {
    start: vi.fn(),
    message: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
  };
  return {
    spinner: vi.fn(() => spinnerInstance),
    spinnerInstance,
  };
});

function progressStream(columns?: number) {
  return Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    write: vi.fn(),
  }) as unknown as NodeJS.WriteStream & { write: ReturnType<typeof vi.fn> };
}

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
    clackMocks.spinnerInstance.clear.mockClear();
  });

  it.each([
    "Checking channel status (probe)…",
    "\u001b[36m检查频道 👩‍💻 状态检查频道状态检查频道状态\u001b[0m",
  ])("keeps initial and updated spinner labels within the display width: %s", (label) => {
    const stream = progressStream(32);
    const progress = createCliProgress({ label, stream });
    try {
      const initial = clackMocks.spinnerInstance.start.mock.calls.at(-1)?.[0] as string;
      expect(visibleWidth(initial)).toBeLessThanOrEqual(25);
      expect(stripAnsi(initial)).toMatch(/…$/u);
      progress.setLabel(`Updated ${label}`);
      const updated = clackMocks.spinnerInstance.message.mock.calls.at(-1)?.[0] as string;
      expect(visibleWidth(updated)).toBeLessThanOrEqual(25);
      expect(stripAnsi(updated)).toMatch(/^Updated .*…$/u);
    } finally {
      progress.done();
    }
    expect(stream.listenerCount("resize")).toBe(0);
  });

  it.each([80, undefined, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    "preserves fitting or unknown-width spinner labels at %s columns",
    (columns) => {
      const stream = progressStream(columns);
      const label = "Checking channel status (probe)…";
      const progress = createCliProgress({ label, stream });
      try {
        expect(stripAnsi(clackMocks.spinnerInstance.start.mock.calls.at(-1)?.[0] as string)).toBe(
          label,
        );
      } finally {
        progress.done();
      }
      expect(stream.listenerCount("resize")).toBe(0);
    },
  );

  it("tightens the spinner width on resize without exceeding its original cleanup width", () => {
    const stream = progressStream(32);
    const progress = createCliProgress({ label: "Checking channel status (probe)…", stream });
    try {
      expect(stream.listenerCount("resize")).toBe(1);
      stream.columns = 80;
      stream.emit("resize");
      progress.setLabel("Checking channel status (probe)…");
      expect(
        visibleWidth(clackMocks.spinnerInstance.message.mock.calls.at(-1)?.[0] as string),
      ).toBeLessThanOrEqual(25);
      stream.columns = 20;
      stream.emit("resize");
      expect(
        visibleWidth(clackMocks.spinnerInstance.message.mock.calls.at(-1)?.[0] as string),
      ).toBeLessThanOrEqual(13);
      stream.columns = 80;
      stream.emit("resize");
      progress.setLabel("Another long channel status message");
      expect(
        visibleWidth(clackMocks.spinnerInstance.message.mock.calls.at(-1)?.[0] as string),
      ).toBeLessThanOrEqual(13);
    } finally {
      progress.done();
    }
    expect(stream.listenerCount("resize")).toBe(0);
    const calls = clackMocks.spinnerInstance.message.mock.calls.length;
    stream.emit("resize");
    expect(clackMocks.spinnerInstance.message).toHaveBeenCalledTimes(calls);
  });

  it.each([1, 6, 7])("retains OSC progress without a spinner at %s columns", (columns) => {
    vi.stubEnv("TERM_PROGRAM", "ghostty");
    const stream = progressStream(columns);
    const label = "Checking channel status (probe)…";
    const progress = createCliProgress({ label, stream });
    try {
      expect(clackMocks.spinner).not.toHaveBeenCalled();
      expect(stream.listenerCount("resize")).toBe(0);
      expect(stream.write).toHaveBeenCalledWith(`\u001b]9;4;3;;${label}\u001b\\`);
      progress.setPercent(50);
      expect(stream.write).toHaveBeenCalledWith(`\u001b]9;4;1;50;${label}\u001b\\`);
    } finally {
      progress.done();
      vi.unstubAllEnvs();
    }
  });

  it("clears a spinner once on tiny resize while keeping OSC progress alive", () => {
    vi.stubEnv("TERM_PROGRAM", "ghostty");
    const stream = progressStream(32);
    const progress = createCliProgress({ label: "Checking channel status (probe)…", stream });
    try {
      stream.columns = 6;
      stream.emit("resize");
      expect(clackMocks.spinnerInstance.clear).toHaveBeenCalledTimes(1);
      expect(clackMocks.spinnerInstance.stop).not.toHaveBeenCalled();
      expect(stream.listenerCount("resize")).toBe(0);
      stream.columns = 80;
      stream.emit("resize");
      progress.setLabel("Still working");
      progress.setPercent(50);
      expect(stream.write).toHaveBeenCalledWith("\u001b]9;4;1;50;Still working\u001b\\");
      expect(clackMocks.spinnerInstance.start).toHaveBeenCalledTimes(1);
    } finally {
      progress.done();
      progress.done();
      vi.unstubAllEnvs();
    }
    expect(clackMocks.spinnerInstance.clear).toHaveBeenCalledTimes(1);
    expect(clackMocks.spinnerInstance.stop).not.toHaveBeenCalled();
  });

  it("removes the spinner resize listener when finished before its delayed start", () => {
    vi.useFakeTimers();
    const stream = progressStream(32);
    const progress = createCliProgress({ label: "Delayed", stream, delayMs: 100 });
    try {
      progress.done();
      stream.emit("resize");
      vi.runAllTimers();
      expect(stream.listenerCount("resize")).toBe(0);
      expect(clackMocks.spinnerInstance.start).not.toHaveBeenCalled();
    } finally {
      progress.done();
      vi.useRealTimers();
    }
  });

  it.each(["line", "log", "none"] as const)(
    "does not clamp labels or listen for resize with fallback=%s",
    (fallback) => {
      const stream = progressStream(10);
      stream.isTTY = fallback !== "log";
      const label = "Checking channel status (probe)…";
      const progress = createCliProgress({ label, stream, fallback });
      try {
        expect(clackMocks.spinner).not.toHaveBeenCalled();
        expect(stream.listenerCount("resize")).toBe(0);
        if (fallback !== "none") {
          expect(
            stream.write.mock.calls.some(([chunk]) => stripAnsi(String(chunk)).includes(label)),
          ).toBe(true);
        }
      } finally {
        progress.done();
      }
    },
  );

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

  it("does not render progress updates after the reporter is finished", () => {
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
    progress.done();
    progress.setLabel("Late progress");
    progress.setPercent(50);
    progress.tick();

    expect(writes).toEqual(["Indexing memory... 0%\n"]);
  });

  it("does not stop an interactive spinner more than once", () => {
    const stream = {
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    const progress = createCliProgress({ label: "Loading", stream });
    progress.done();
    progress.done();

    expect(clackMocks.spinnerInstance.stop).toHaveBeenCalledTimes(1);
  });

  it("does not let a finished reporter clear or unlock a newer progress line", () => {
    const firstStream = {
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;
    const secondWrite = vi.fn();
    const secondStream = {
      isTTY: true,
      write: secondWrite,
    } as unknown as NodeJS.WriteStream;
    const thirdWrite = vi.fn();
    const thirdStream = {
      isTTY: true,
      write: thirdWrite,
    } as unknown as NodeJS.WriteStream;

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
