import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enableConsoleCapture,
  resetLogger,
  routeLogsToStderr,
  setConsoleTimestampPrefix,
  setLoggerOverride,
} from "../logging.js";
import { defaultRuntime } from "../runtime.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { loggingState } from "./state.js";
import {
  captureConsoleSnapshot,
  type ConsoleSnapshot,
  restoreConsoleSnapshot,
} from "./test-helpers/console-snapshot.js";

let snapshot: ConsoleSnapshot;
const logPathTracker = createSuiteLogPathTracker("openclaw-log-");

beforeAll(async () => {
  await logPathTracker.setup();
});

beforeEach(() => {
  snapshot = captureConsoleSnapshot();
  loggingState.consolePatched = false;
  loggingState.forceConsoleToStderr = false;
  loggingState.consoleTimestampPrefix = false;
  loggingState.rawConsole = null;
  resetLogger();
});

afterEach(() => {
  restoreConsoleSnapshot(snapshot);
  loggingState.consolePatched = false;
  loggingState.forceConsoleToStderr = false;
  loggingState.consoleTimestampPrefix = false;
  loggingState.rawConsole = null;
  resetLogger();
  setLoggerOverride(null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await logPathTracker.cleanup();
});

describe("enableConsoleCapture", () => {
  it("swallows EIO from stderr writes", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw eioError();
    });
    routeLogsToStderr();
    enableConsoleCapture();
    expect(() => console.log("hello")).not.toThrow();
  });

  it("swallows EIO from original console writes", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    console.log = () => {
      throw eioError();
    };
    enableConsoleCapture();
    expect(() => console.log("hello")).not.toThrow();
  });

  it("prefixes console output with timestamps when enabled", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    const now = new Date("2026-01-17T18:01:02.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const warn = vi.fn();
    console.warn = warn;
    setConsoleTimestampPrefix(true);
    enableConsoleCapture();
    console.warn("[EventQueue] Slow listener detected");
    expect(warn).toHaveBeenCalledTimes(1);
    const firstArg = String(warn.mock.calls[0]?.[0] ?? "");
    // Timestamp uses local time with timezone offset instead of UTC "Z" suffix
    expect(firstArg).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \[EventQueue\]/,
    );
    vi.useRealTimers();
  });

  it("does not double-prefix timestamps", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    const warn = vi.fn();
    console.warn = warn;
    setConsoleTimestampPrefix(true);
    enableConsoleCapture();
    console.warn("12:34:56 [exec] hello");
    expect(warn).toHaveBeenCalledWith("12:34:56 [exec] hello");
  });

  it("prefixes JSON console output when timestamp prefix is enabled", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    const log = vi.fn();
    console.log = log;
    setConsoleTimestampPrefix(true);
    enableConsoleCapture();
    const payload = JSON.stringify({ ok: true });
    console.log(payload);
    expect(log).toHaveBeenCalledTimes(1);
    const firstArg = String(log.mock.calls[0]?.[0] ?? "");
    expect(firstArg).toMatch(/^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T)/);
    expect(firstArg.endsWith(` ${payload}`)).toBe(true);
  });

  it("keeps diagnostics on stderr while runtime JSON stays on stdout", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    routeLogsToStderr();
    enableConsoleCapture();

    console.log("diag");
    defaultRuntime.writeJson({ ok: true });

    expect(stderrWrite).toHaveBeenCalledWith("diag\n");
    expect(stdoutWrite).toHaveBeenCalledWith('{\n  "ok": true\n}\n');
  });

  it.each([
    { name: "stdout", stream: process.stdout },
    { name: "stderr", stream: process.stderr },
  ])("swallows async EPIPE on $name", ({ stream }) => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    enableConsoleCapture();
    const epipe = new Error("write EPIPE") as NodeJS.ErrnoException;
    epipe.code = "EPIPE";
    expect(() => stream.emit("error", epipe)).not.toThrow();
  });

  it("rethrows non-EPIPE errors on stdout", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    enableConsoleCapture();
    const other = new Error("EACCES") as NodeJS.ErrnoException;
    other.code = "EACCES";
    expect(() => process.stdout.emit("error", other)).toThrow("EACCES");
  });
});

function tempLogPath() {
  return logPathTracker.nextPath();
}

function eioError() {
  const err = new Error("EIO") as NodeJS.ErrnoException;
  err.code = "EIO";
  return err;
}
