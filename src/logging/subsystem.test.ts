// Subsystem logger tests cover per-subsystem log routing and filtering.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setVerbose } from "../global-state.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import { setConsoleSubsystemFilter, shouldLogSubsystemToConsole } from "./console.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { applyLoggingConfig, resetLogger, setLoggerOverride } from "./logger.js";
import { testApi } from "./logger.test-support.js";
import { loggingState } from "./state.js";
import { createSubsystemLogger } from "./subsystem.js";

const logPathTracker = createSuiteLogPathTracker("openclaw-subsystem-log-");

function installConsoleMethodSpy(method: "log" | "warn" | "error") {
  const spy = vi.fn();
  loggingState.rawConsole = {
    log: method === "log" ? spy : vi.fn(),
    info: vi.fn(),
    warn: method === "warn" ? spy : vi.fn(),
    error: method === "error" ? spy : vi.fn(),
  };
  return spy;
}

beforeAll(async () => {
  await logPathTracker.setup();
});

afterEach(async () => {
  // Settle owned file writes before resetting logging state or removing the suite directory.
  await testApi.flushFileLogQueueForTests();
  setConsoleSubsystemFilter(null);
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
  setVerbose(false);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  await logPathTracker.cleanup();
});

describe("createSubsystemLogger().isEnabled", () => {
  it("returns true for any/file when only file logging would emit", () => {
    setLoggerOverride({ level: "debug", consoleLevel: "silent" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(true);
    expect(log.isEnabled("debug", "file")).toBe(true);
    expect(log.isEnabled("debug", "console")).toBe(false);
  });

  it("returns true for any/console when only console logging would emit", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "debug" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(true);
    expect(log.isEnabled("debug", "console")).toBe(true);
    expect(log.isEnabled("debug", "file")).toBe(false);
  });

  it("uses threshold ordering for non-equal console levels", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "fatal" });
    const fatalOnly = createSubsystemLogger("agent/embedded");

    expect(fatalOnly.isEnabled("error", "console")).toBe(false);
    expect(fatalOnly.isEnabled("fatal", "console")).toBe(true);

    setLoggerOverride({ level: "silent", consoleLevel: "trace" });
    const traceLogger = createSubsystemLogger("agent/embedded");

    expect(traceLogger.isEnabled("debug", "console")).toBe(true);
  });

  it("never treats silent as an emittable console level", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("silent", "console")).toBe(false);
  });

  it("returns false when neither console nor file logging would emit", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(false);
    expect(log.isEnabled("debug", "console")).toBe(false);
    expect(log.isEnabled("debug", "file")).toBe(false);
  });

  it("honors console subsystem filters for console target", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("info", "console")).toBe(false);
  });

  it("does not apply console subsystem filters to file target", () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("info", "file")).toBe(true);
    expect(log.isEnabled("info")).toBe(true);
  });

  it("treats missing subsystem labels as non-matches when filters are active", () => {
    setConsoleSubsystemFilter(["gateway"]);

    expect(shouldLogSubsystemToConsole(undefined as unknown as string)).toBe(false);
  });

  it("disables console logging when a malformed subsystem logger checks enablement", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger(undefined as unknown as string);

    expect(log.isEnabled("info", "console")).toBe(false);
  });

  it.each([undefined, "constructor", "toString", "__proto__"])(
    "emits console output for subsystem label %s",
    (subsystem) => {
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      const warn = installConsoleMethodSpy("warn");
      const log = createSubsystemLogger(subsystem as unknown as string);

      log.warn("subsystem diagnostic");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(mockCall(warn)[0])).toContain(`[${subsystem ?? "unknown"}]`);
    },
  );

  it("suppresses probe warnings for embedded subsystems based on structured run metadata", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("agent/embedded").child("failover");

    log.warn("embedded run failover decision", {
      runId: "probe-test-run",
      consoleMessage: "embedded run failover decision",
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["agent/embedded", true],
    ["model-fallback/decision", true],
    ["  agent/embedded/failover  ", true],
    ["agent/embeddedness", false],
    ["model-fallback-other", false],
    ["Agent/Embedded", false],
  ] as const)("keeps probe policy dynamic for retained %s loggers", (subsystem, suppressed) => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const sink = vi.fn();
    loggingState.rawConsole = { log: sink, info: sink, warn: sink, error: sink };
    const log = createSubsystemLogger(subsystem);

    for (const verbose of [false, true, false]) {
      setVerbose(verbose);
      sink.mockClear();
      log.warn("runId=probe-retained warning");
      log.raw("runId=probe-retained raw");
      expect(sink).toHaveBeenCalledTimes(suppressed && !verbose ? 0 : 2);
    }
  });

  it("keeps setup-inference probe warnings in the file log while suppressing console", async () => {
    const file = logPathTracker.nextPath();
    setLoggerOverride({ level: "warn", consoleLevel: "warn", file });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("agent/embedded");

    log.warn("embedded run failover decision", {
      runId: "probe-setup-inference-test-run",
      provider: "openai",
      consoleMessage: "embedded run failover decision: provider=openai error=Authentication failed",
    });
    log.warn("embedded run agent end", {
      runId: "probe-setup-inference-test-run",
      provider: "openai",
      consoleMessage: "embedded run agent end: provider=openai error=Authentication failed",
    });

    expect(warn).not.toHaveBeenCalled();
    await testApi.flushFileLogQueueForTests();
    const fileLog = fs.readFileSync(file, "utf8");
    expect(fileLog).toContain("embedded run failover decision");
    expect(fileLog).toContain("embedded run agent end");
    expect(fileLog).toContain('"provider":"openai"');
  });

  it("does not suppress probe errors for embedded subsystems", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const error = installConsoleMethodSpy("error");
    const log = createSubsystemLogger("agent/embedded").child("failover");

    log.error("embedded run failover decision", {
      runId: "probe-test-run",
      consoleMessage: "embedded run failover decision",
    });

    expect(error).toHaveBeenCalledTimes(1);
  });

  it("suppresses probe warnings for model-fallback child subsystems based on structured run metadata", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("model-fallback").child("decision");

    log.warn("model fallback decision", {
      runId: "probe-test-run",
      consoleMessage: "model fallback decision",
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not suppress probe errors for model-fallback child subsystems", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const error = installConsoleMethodSpy("error");
    const log = createSubsystemLogger("model-fallback").child("decision");

    log.error("model fallback decision", {
      runId: "probe-test-run",
      consoleMessage: "model fallback decision",
    });

    expect(error).toHaveBeenCalledTimes(1);
  });

  it("still emits non-probe warnings for embedded subsystems", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("agent/embedded").child("auth-profiles");

    log.warn("auth profile failure state updated", {
      runId: "run-123",
      consoleMessage: "auth profile failure state updated",
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still emits non-probe model-fallback child warnings", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("model-fallback").child("decision");

    log.warn("model fallback decision", {
      runId: "run-123",
      consoleMessage: "model fallback decision",
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("redacts sensitive tokens at the console sink so subsystem writes do not leak secrets (#73284)", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("gateway");
    const secret = "sk-supersecretvaluefortest12345";

    log.warn(`token=${secret}`);

    expect(warn).toHaveBeenCalledTimes(1);
    const written = String(mockCall(warn)[0]);
    expect(written).not.toContain(secret);
    expect(written).toMatch(/sk-sup…2345|\*\*\*/);
  });

  it("redacts Bearer tokens on subsystem error console writes", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const error = installConsoleMethodSpy("error");
    const log = createSubsystemLogger("gateway").child("auth");
    const bearer = "Bearer abcdefghijklmnopqrstuvwxyz";

    log.error(`Authorization failed: ${bearer}`);

    expect(error).toHaveBeenCalledTimes(1);
    const written = String(mockCall(error)[0]);
    expect(written).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(written).toContain("Bearer ");
  });

  it.each(["pretty", "compact"] as const)(
    "preserves redaction and ANSI resets as color settings change in %s style",
    (consoleStyle) => {
      vi.stubEnv("NO_COLOR", "1");
      setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle });
      const logSpy = installConsoleMethodSpy("log");
      const log = createSubsystemLogger("gateway/auth");
      const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";

      for (const forceColor of ["1", "0", "1"]) {
        vi.stubEnv("FORCE_COLOR", forceColor);
        logSpy.mockClear();
        log.info(`provider API_KEY=${secret}`);

        expect(logSpy).toHaveBeenCalledTimes(1);
        const written = String(mockCall(logSpy)[0]);
        expect(written).not.toContain(secret);
        expect(written).toContain("API_KEY=***");
        expect(written).toContain("[auth]");
        expect(written.endsWith("\u001B[39m")).toBe(forceColor === "1");
      }
    },
  );

  it("redacts sensitive tokens from raw subsystem console output", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const logSpy = installConsoleMethodSpy("log");
    const log = createSubsystemLogger("gateway/auth");
    const secret = "sk-rawtokenabcdefghijklmnopqrstuvwxyz123456";

    log.raw(`raw token ${secret}`);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const written = String(mockCall(logSpy)[0]);
    expect(written).not.toContain(secret);
    expect(written).toContain("sk-raw…3456");
  });

  it("wraps raw subsystem output when console style is JSON", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });
    const logSpy = installConsoleMethodSpy("log");

    createSubsystemLogger("gateway/auth").raw("raw diagnostic");

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(mockCall(logSpy)[0]))).toMatchObject({
      level: "info",
      subsystem: "gateway/auth",
      message: "raw diagnostic",
    });
  });

  it.each(["pretty", "compact"] as const)(
    "keeps raw subsystem output unchanged in %s style",
    (consoleStyle) => {
      setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle });
      const logSpy = installConsoleMethodSpy("log");

      createSubsystemLogger("gateway/auth").raw("raw diagnostic");

      expect(logSpy).toHaveBeenCalledWith("raw diagnostic");
    },
  );

  it("preserves structured subsystem fields through the shared JSON formatter", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
    const warn = installConsoleMethodSpy("warn");

    createSubsystemLogger("gateway/auth").warn("authentication retry", { attempt: 2 });

    expect(JSON.parse(String(mockCall(warn)[0]))).toMatchObject({
      level: "warn",
      subsystem: "gateway/auth",
      message: "authentication retry",
      attempt: 2,
    });
  });

  it("keeps long-lived subsystem loggers on the current-day rolling file", async () => {
    const logDir = path.dirname(logPathTracker.nextPath());
    const firstDay = path.join(logDir, "openclaw-2026-01-01.log");
    const secondDay = path.join(logDir, "openclaw-2026-01-02.log");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T08:00:00Z"));
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: firstDay });
    const log = createSubsystemLogger("diagnostics");

    log.info("first day subsystem log");
    vi.setSystemTime(new Date("2026-01-02T08:00:00Z"));
    log.info("second day subsystem log");
    await testApi.flushFileLogQueueForTests();

    expect(fs.readFileSync(firstDay, "utf8")).toContain("first day subsystem log");
    expect(fs.readFileSync(secondDay, "utf8")).toContain("second day subsystem log");
    expect(fs.readFileSync(firstDay, "utf8")).not.toContain("second day subsystem log");
  });

  it("keeps a retained logger on the new file after reset", async () => {
    const firstFile = logPathTracker.nextPath();
    const secondFile = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: firstFile });
    const log = createSubsystemLogger("diagnostics");

    log.info("first line");
    log.info("second line");

    resetLogger();
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: secondFile });
    log.info("after reset");
    await testApi.flushFileLogQueueForTests();
    expect(fs.readFileSync(firstFile, "utf8")).toContain("first line");
    expect(fs.readFileSync(firstFile, "utf8")).not.toContain("after reset");
    expect(fs.readFileSync(secondFile, "utf8")).toContain("after reset");
  });

  it("applies the new file and level to a retained logger", async () => {
    const firstFile = logPathTracker.nextPath();
    const secondFile = logPathTracker.nextPath();
    vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
    applyLoggingConfig({ level: "info", consoleLevel: "silent", file: firstFile });
    const log = createSubsystemLogger("diagnostics");

    log.info("first line");
    log.info("second line");
    expect(log.isEnabled("debug", "file")).toBe(false);

    applyLoggingConfig({ level: "debug", consoleLevel: "silent", file: secondFile });
    expect(log.isEnabled("debug", "file")).toBe(true);
    log.debug("after applied config");
    await testApi.flushFileLogQueueForTests();
    expect(fs.readFileSync(firstFile, "utf8")).toContain("first line");
    expect(fs.readFileSync(firstFile, "utf8")).not.toContain("after applied config");
    expect(fs.readFileSync(secondFile, "utf8")).toContain("after applied config");
  });
});
