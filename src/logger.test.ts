import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isVerbose, isYes, logVerbose, setVerbose, setYes } from "./globals.js";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "./logger.js";
import {
  resetLogger,
  setLoggerOverride,
  stripRedundantSubsystemPrefixForConsole,
} from "./logging.js";
import type { RuntimeEnv } from "./runtime.js";
import { withTempDirSync } from "./test-helpers/temp-dir.js";

describe("logger helpers", () => {
  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    setVerbose(false);
    setYes(false);
  });

  it("formats messages through runtime log/error", () => {
    const log = vi.fn();
    const error = vi.fn();
    const runtime: RuntimeEnv = { log, error, exit: vi.fn() };

    logInfo("info", runtime);
    logWarn("warn", runtime);
    logSuccess("ok", runtime);
    logError("bad", runtime);

    expect(log).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("only logs debug when verbose is enabled", () => {
    const logVerbose = vi.spyOn(console, "log").mockImplementation(() => {});
    setVerbose(false);
    logDebug("quiet");
    expect(logVerbose).not.toHaveBeenCalled();

    setVerbose(true);
    logVerbose.mockClear();
    logDebug("loud");
    expect(logVerbose).toHaveBeenCalled();
    logVerbose.mockRestore();
  });

  it("writes to configured log file at configured level", () => {
    withTempDirSync({ prefix: "openclaw-log-test-" }, (dir) => {
      const logPath = path.join(dir, "openclaw.log");
      setLoggerOverride({ level: "info", file: logPath });
      fs.writeFileSync(logPath, "");
      logInfo("hello");
      logDebug("debug-only"); // may be filtered depending on level mapping
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    });
  });

  it("filters messages below configured level", () => {
    withTempDirSync({ prefix: "openclaw-log-test-" }, (dir) => {
      const logPath = path.join(dir, "openclaw.log");
      setLoggerOverride({ level: "warn", file: logPath });
      logInfo("info-only");
      logWarn("warn-only");
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toContain("warn-only");
    });
  });

  it("uses daily rolling log files and prunes old ones", () => {
    withTempDirSync({ prefix: "openclaw-log-test-" }, (dir) => {
      resetLogger();
      const today = localDateString(new Date());
      const todayPath = path.join(dir, `openclaw-${today}.log`);
      setLoggerOverride({ level: "info", file: todayPath });

      // create an old file to be pruned
      const oldPath = path.join(dir, "openclaw-2000-01-01.log");
      fs.writeFileSync(oldPath, "old");
      fs.utimesSync(oldPath, new Date(0), new Date(0));

      logInfo("roll-me");

      expect(fs.existsSync(todayPath)).toBe(true);
      expect(fs.readFileSync(todayPath, "utf-8")).toContain("roll-me");
      expect(fs.existsSync(oldPath)).toBe(false);
    });
  });
});

describe("globals", () => {
  afterEach(() => {
    setVerbose(false);
    setYes(false);
    vi.restoreAllMocks();
  });

  it("toggles verbose flag and logs when enabled", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setVerbose(false);
    logVerbose("hidden");
    expect(logSpy).not.toHaveBeenCalled();

    setVerbose(true);
    logVerbose("shown");
    expect(isVerbose()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("shown"));
  });

  it("stores yes flag", () => {
    setYes(true);
    expect(isYes()).toBe(true);
    setYes(false);
    expect(isYes()).toBe(false);
  });
});

describe("stripRedundantSubsystemPrefixForConsole", () => {
  it.each([
    { input: "discord: hello", subsystem: "discord", expected: "hello" },
    { input: "WhatsApp: hello", subsystem: "whatsapp", expected: "hello" },
    { input: "discord gateway: closed", subsystem: "discord", expected: "gateway: closed" },
    {
      input: "[discord] connection stalled",
      subsystem: "discord",
      expected: "connection stalled",
    },
  ] as const)("drops known subsystem prefix for $input", ({ input, subsystem, expected }) => {
    expect(stripRedundantSubsystemPrefixForConsole(input, subsystem)).toBe(expected);
  });

  it("keeps messages that do not start with the subsystem", () => {
    expect(stripRedundantSubsystemPrefixForConsole("discordant: hello", "discord")).toBe(
      "discordant: hello",
    );
  });
});

function localDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
