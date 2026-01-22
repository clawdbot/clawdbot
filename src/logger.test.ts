import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { setVerbose } from "./globals.js";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "./logger.js";
import { DEFAULT_LOG_DIR, resetLogger, setLoggerOverride } from "./logging.js";
import type { RuntimeEnv } from "./runtime.js";

describe("logger helpers", () => {
  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    setVerbose(false);
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
    const logVerbose = vi.spyOn(console, "log");
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
    const logPath = pathForTest();
    cleanup(logPath);
    setLoggerOverride({ level: "info", file: logPath });
    fs.writeFileSync(logPath, "");
    logInfo("hello");
    logDebug("debug-only"); // may be filtered depending on level mapping
    const content = fs.readFileSync(logPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
    cleanup(logPath);
  });

  it("filters messages below configured level", () => {
    const logPath = pathForTest();
    cleanup(logPath);
    setLoggerOverride({ level: "warn", file: logPath });
    logInfo("info-only");
    logWarn("warn-only");
    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("warn-only");
    cleanup(logPath);
  });

  it("uses daily rolling default log file and prunes old ones", () => {
    resetLogger();
    setLoggerOverride({}); // force defaults regardless of user config
    const today = localDateString(new Date());
    const todayPath = path.join(DEFAULT_LOG_DIR, `clawdbot-${today}.log`);

    // create an old file to be pruned
    const oldPath = path.join(DEFAULT_LOG_DIR, "clawdbot-2000-01-01.log");
    fs.mkdirSync(DEFAULT_LOG_DIR, { recursive: true });
    fs.writeFileSync(oldPath, "old");
    fs.utimesSync(oldPath, new Date(0), new Date(0));
    cleanup(todayPath);

    logInfo("roll-me");

    expect(fs.existsSync(todayPath)).toBe(true);
    expect(fs.readFileSync(todayPath, "utf-8")).toContain("roll-me");
    expect(fs.existsSync(oldPath)).toBe(false);

    cleanup(todayPath);
  });
});

function pathForTest() {
  const file = path.join(os.tmpdir(), `clawdbot-log-${crypto.randomUUID()}.log`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function cleanup(file: string) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

function localDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
