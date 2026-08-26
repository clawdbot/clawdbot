// Console capture tests cover intercepting and restoring console output.
import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setVerbose } from "../global-state.js";
import { logError, logInfo, logWarn } from "../logger.js";
import {
  createSubsystemLogger,
  enableConsoleCapture,
  resetLogger,
  routeLogsToStderr,
  setConsoleTimestampPrefix,
  setLoggerOverride,
} from "../logging.js";
import { defaultRuntime } from "../runtime.js";
import { withEnv } from "../test-utils/env.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { applyLoggingConfig } from "./logger.js";
import { testApi } from "./logger.test-support.js";
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
  setVerbose(false);
  resetLogger();
});

afterEach(() => {
  restoreConsoleSnapshot(snapshot);
  loggingState.consolePatched = false;
  loggingState.forceConsoleToStderr = false;
  loggingState.consoleTimestampPrefix = false;
  loggingState.rawConsole = null;
  setVerbose(false);
  resetLogger();
  setLoggerOverride(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await logPathTracker.cleanup();
});

function firstMockArgAsString(mock: { mock: { calls: readonly unknown[][] } }): string {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected mock call");
  }
  return String(call[0]);
}

describe("enableConsoleCapture", () => {
  const secret = "sk-testsecret1234567890abcd";

  it("swallows EIO from stderr writes", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw eioError();
    });
    routeLogsToStderr();
    enableConsoleCapture();
    expect(console.log("hello")).toBeUndefined();
  });

  it("swallows EIO from original console writes", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    console.log = () => {
      throw eioError();
    };
    enableConsoleCapture();
    expect(console.log("hello")).toBeUndefined();
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
    const firstArg = firstMockArgAsString(warn);
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
    const firstArg = firstMockArgAsString(log);
    expect(firstArg).toMatch(/^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T)/);
    expect(firstArg.endsWith(` ${payload}`)).toBe(true);
  });

  it("wraps console passthrough output when console style is JSON", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });
    const warn = vi.fn();
    console.warn = warn;
    enableConsoleCapture();

    console.warn("tool failed", { attempt: 1 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstMockArgAsString(warn))).toMatchObject({
      level: "warn",
      message: "tool failed { attempt: 1 }",
    });
  });

  it("does not rewrap structured subsystem output", () => {
    setLoggerOverride({ level: "info", consoleLevel: "warn", consoleStyle: "json" });
    const warn = vi.fn();
    console.warn = warn;
    enableConsoleCapture();

    createSubsystemLogger("gateway/auth").warn("authentication retry", { attempt: 2 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstMockArgAsString(warn))).toMatchObject({
      level: "warn",
      subsystem: "gateway/auth",
      message: "authentication retry",
      attempt: 2,
    });
  });

  it("keeps console trace output structured at trace level", () => {
    setLoggerOverride({ level: "info", consoleLevel: "trace", consoleStyle: "json" });
    const error = vi.fn();
    console.error = error;
    enableConsoleCapture();

    console.trace("trace diagnostic\nsecond line");

    expect(error).toHaveBeenCalledTimes(1);
    const event = JSON.parse(firstMockArgAsString(error)) as Record<string, unknown>;
    expect(event).toMatchObject({ level: "trace" });
    expect(event).toMatchObject({ message: "trace diagnostic\nsecond line" });
    expect(event.stack).toMatch(/^Trace: trace diagnostic\nsecond line\n/u);
    expect(String(event.stack)).not.toContain("forwardedConsoleCall");
  });

  it("keeps forced-stderr console trace output structured", () => {
    setLoggerOverride({ level: "info", consoleLevel: "trace", consoleStyle: "json" });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    routeLogsToStderr();
    enableConsoleCapture();

    console.trace("trace diagnostic");

    expect(stderrWrite).toHaveBeenCalledTimes(1);
    const event = JSON.parse(firstMockArgAsString(stderrWrite)) as Record<string, unknown>;
    expect(event).toMatchObject({ level: "trace" });
    expect(event).toMatchObject({ message: "trace diagnostic" });
    expect(event.stack).toMatch(/^Trace: trace diagnostic\n/u);
  });

  it("redacts credentials from structured console trace messages and stacks", () => {
    setLoggerOverride({ level: "info", consoleLevel: "trace", consoleStyle: "json" });
    const error = vi.fn();
    console.error = error;
    enableConsoleCapture();

    console.trace(`Authorization: Bearer ${secret}`);

    const written = firstMockArgAsString(error);
    const event = JSON.parse(written) as Record<string, unknown>;
    expect(event).toMatchObject({ level: "trace" });
    expect(written).not.toContain(secret);
    expect(String(event.message)).toContain("Authorization: Bearer");
    expect(String(event.stack)).toContain("Authorization: Bearer");
  });

  it("redacts multiline patterns before JSON escaping in messages and metadata", () => {
    const configPath = `${tempLogPath()}.json`;
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        logging: {
          redactPatterns: [String.raw`/sensitive-one\nsensitive-two/g`],
          file: "${MISSING_LOG_FILE}",
        },
      }),
      "utf8",
    );
    setLoggerOverride({
      level: "silent",
      consoleLevel: "warn",
      consoleStyle: "json",
    });
    const warn = vi.fn();
    console.warn = warn;

    withEnv({ OPENCLAW_CONFIG_PATH: configPath, MISSING_LOG_FILE: undefined }, () => {
      createSubsystemLogger("sensitive-one\nsensitive-two").warn(
        "prefix sensitive-one\nsensitive-two suffix",
        {
          level: "sensitive-one\nsensitive-two",
          nested: { detail: "sensitive-one\nsensitive-two" },
        },
      );
    });

    const written = firstMockArgAsString(warn);
    const event = JSON.parse(written) as {
      message: string;
      level: string;
      subsystem: string;
      nested: { detail: string };
    };
    expect(written).not.toContain("sensitive-one");
    expect(event.message).not.toContain("sensitive-two");
    expect(event.level).toBe("warn");
    expect(event.subsystem).not.toContain("sensitive-one");
    expect(event.subsystem).not.toContain("sensitive-two");
    expect(event.nested.detail).not.toContain("sensitive-one");
    expect(event.nested.detail).not.toContain("sensitive-two");
  });

  it("keeps custom trace redaction while the configured log file is unresolved", () => {
    const configPath = `${tempLogPath()}.json`;
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        logging: {
          redactPatterns: ["/custom-only-secret/g"],
          file: "${MISSING_LOG_FILE}",
        },
      }),
      "utf8",
    );
    setLoggerOverride({ level: "silent", consoleLevel: "trace", consoleStyle: "json" });
    const error = vi.fn();
    console.error = error;

    withEnv({ OPENCLAW_CONFIG_PATH: configPath, MISSING_LOG_FILE: undefined }, () => {
      enableConsoleCapture();
      console.trace("custom-only-secret");
    });

    const written = firstMockArgAsString(error);
    const event = JSON.parse(written) as { message: string; stack: string };
    expect(written).not.toContain("custom-only-secret");
    expect(event.message).not.toBe("custom-only-secret");
    expect(event.stack).not.toContain("custom-only-secret");
  });

  it("wraps bracket-prefixed root fallback output when console style is JSON", () => {
    setLoggerOverride({
      level: "info",
      file: tempLogPath(),
      consoleLevel: "error",
      consoleStyle: "json",
    });
    const error = vi.fn();
    console.error = error;
    enableConsoleCapture();

    logError("[tools] exec failed");

    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstMockArgAsString(error))).toMatchObject({
      level: "error",
      message: "[tools] exec failed",
    });
  });

  it.each(["pretty", "compact"] as const)(
    "keeps %s console passthrough output unchanged",
    (consoleStyle) => {
      setLoggerOverride({
        level: "info",
        file: tempLogPath(),
        consoleLevel: "info",
        consoleStyle,
      });
      const warn = vi.fn();
      console.warn = warn;
      enableConsoleCapture();

      console.warn("tool failed", { attempt: 1 });

      expect(warn).toHaveBeenCalledWith("tool failed { attempt: 1 }");
    },
  );

  it.each(["pretty", "compact"] as const)(
    "keeps %s bracket-prefixed root fallback output unchanged",
    (consoleStyle) => {
      setLoggerOverride({
        level: "info",
        file: tempLogPath(),
        consoleLevel: "error",
        consoleStyle,
      });
      const error = vi.fn();
      console.error = error;
      enableConsoleCapture();

      logError("[tools] exec failed");

      expect(error).toHaveBeenCalledWith("[tools] exec failed");
    },
  );

  it("wraps forced stderr passthrough output when console style is JSON", () => {
    setLoggerOverride({ level: "info", consoleLevel: "error", consoleStyle: "json" });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    routeLogsToStderr();
    enableConsoleCapture();

    console.error(`Authorization: Bearer ${secret}`);

    expect(stderrWrite).toHaveBeenCalledTimes(1);
    const written = firstMockArgAsString(stderrWrite);
    expect(JSON.parse(written)).toMatchObject({ level: "error" });
    expect(written).not.toContain(secret);
  });

  it("keeps JSON diagnostics structured while runtime JSON stays raw", () => {
    setLoggerOverride({
      level: "info",
      file: tempLogPath(),
      consoleLevel: "info",
      consoleStyle: "json",
    });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    routeLogsToStderr();
    enableConsoleCapture();

    console.log("diag");
    defaultRuntime.writeJson({ ok: true });

    expect(JSON.parse(firstMockArgAsString(stderrWrite))).toMatchObject({
      level: "info",
      message: "diag",
    });
    expect(stdoutWrite).toHaveBeenCalledWith('{\n  "ok": true\n}\n');
  });

  it("routes subsystem-prefixed warnings through one file-log sink", async () => {
    const logPath = tempLogPath();
    setLoggerOverride({ level: "info", file: logPath });
    enableConsoleCapture();

    logWarn("mcp-loopback: conflicting schema definitions");
    await testApi.flushFileLogQueueForTests();

    const content = fs.readFileSync(logPath, "utf-8");
    expect(countMatchingLines(content, "conflicting schema definitions")).toBe(1);
  });

  it("uses the current applied logger generation for each forwarded console call", async () => {
    vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
    const firstFile = tempLogPath();
    const secondFile = tempLogPath();
    applyLoggingConfig({ level: "info", file: firstFile });
    enableConsoleCapture();

    console.log("first applied generation");
    applyLoggingConfig({ level: "info", file: secondFile });
    console.log("second applied generation");
    await testApi.flushFileLogQueueForTests();

    expect(fs.readFileSync(firstFile, "utf8")).toContain("first applied generation");
    expect(fs.readFileSync(firstFile, "utf8")).not.toContain("second applied generation");
    expect(fs.readFileSync(secondFile, "utf8")).toContain("second applied generation");
  });

  it.each([
    { name: "info", log: logInfo, consoleMethod: "log" as const },
    { name: "error", log: logError, consoleMethod: "error" as const },
  ])(
    "routes non-subsystem $name logs through one file and console sink",
    async ({ log, consoleMethod }) => {
      vi.stubEnv("OPENCLAW_TEST_RUNTIME_LOG", "1");
      const logPath = tempLogPath();
      setLoggerOverride({ level: "info", file: logPath });
      const consoleSpy = vi.fn();
      console[consoleMethod] = consoleSpy;
      enableConsoleCapture();

      log(`[tools] operation failed: Authorization: Bearer ${secret}`);
      await testApi.flushFileLogQueueForTests();

      expect(
        countMatchingLines(fs.readFileSync(logPath, "utf-8"), "[tools] operation failed"),
      ).toBe(1);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const consoleLine = firstMockArgAsString(consoleSpy);
      expect(consoleLine).toContain("[tools] operation failed");
      expect(consoleLine).not.toContain(secret);
    },
  );

  it("redacts credentials before forwarding console output", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    const log = vi.fn();
    console.log = log;
    enableConsoleCapture();

    console.log("apiKey:", secret);

    expect(log).toHaveBeenCalledTimes(1);
    const line = firstMockArgAsString(log);
    expect(line).toContain("apiKey:");
    expect(line).not.toContain(secret);
  });

  it("redacts credentials before writing forced stderr console output", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    routeLogsToStderr();
    enableConsoleCapture();

    console.error(`Authorization: Bearer ${secret}`);

    expect(stderrWrite).toHaveBeenCalledTimes(1);
    const line = firstMockArgAsString(stderrWrite);
    expect(line).toContain("Authorization: Bearer");
    expect(line).not.toContain(secret);
  });

  it("redacts credentials when timestamp prefixing console output", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    const warn = vi.fn();
    console.warn = warn;
    setConsoleTimestampPrefix(true);
    enableConsoleCapture();

    console.warn(`token=${secret}`);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = firstMockArgAsString(warn);
    expect(line).toMatch(/^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T)/);
    expect(line).toContain("token=");
    expect(line).not.toContain(secret);
  });

  it.each([
    { name: "stdout", stream: process.stdout },
    { name: "stderr", stream: process.stderr },
  ])("exits on async EPIPE on $name", ({ stream }) => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
    try {
      setLoggerOverride({ level: "info", file: tempLogPath() });
      loggingState.streamErrorHandlersInstalled = false;
      enableConsoleCapture();
      const epipe = new Error("write EPIPE") as NodeJS.ErrnoException;
      epipe.code = "EPIPE";
      stream.emit("error", epipe);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("preserves an existing nonzero exit code on async EPIPE", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
    const originalExitCode = process.exitCode;
    try {
      process.exitCode = 2;
      setLoggerOverride({ level: "info", file: tempLogPath() });
      loggingState.streamErrorHandlersInstalled = false;
      enableConsoleCapture();
      const epipe = new Error("write EPIPE") as NodeJS.ErrnoException;
      epipe.code = "EPIPE";
      process.stderr.emit("error", epipe);
      expect(exitSpy).toHaveBeenCalledWith(2);
    } finally {
      process.exitCode = originalExitCode;
      exitSpy.mockRestore();
    }
  });

  it("rethrows non-EPIPE errors on stdout", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    enableConsoleCapture();
    const other = new Error("EACCES") as NodeJS.ErrnoException;
    other.code = "EACCES";
    expect(() => process.stdout.emit("error", other)).toThrow("EACCES");
  });

  it("suppresses libsignal session dumps even in verbose mode", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    const info = vi.fn();
    console.info = info;
    setVerbose(true);
    enableConsoleCapture();

    console.info("Closing session:", {
      currentRatchet: { rootKey: Buffer.from("root-key") },
      privKey: "private-key",
    });

    expect(info).not.toHaveBeenCalled();
  });
});

function tempLogPath() {
  return logPathTracker.nextPath();
}

function countMatchingLines(value: string, needle: string): number {
  return value.split(/\r?\n/u).filter((line) => line.includes(needle)).length;
}

function eioError() {
  const err = new Error("EIO") as NodeJS.ErrnoException;
  err.code = "EIO";
  return err;
}
