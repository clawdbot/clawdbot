import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLogger,
  getResolvedLoggerSettings,
  resetLogger,
  setLoggerOverride,
} from "../logging.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const logPathTracker = createSuiteLogPathTracker("openclaw-log-cap-");

function rotatedLogPath(file: string, index: number): string {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  return `${base}.${index}${ext}`;
}

describe("log file size cap", () => {
  let logPath = "";

  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
    logPath = logPathTracker.nextPath();
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      fs.rmSync(logPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
  });

  it("defaults maxFileBytes to 100 MB when unset", () => {
    setLoggerOverride({ level: "info", file: logPath });
    expect(getResolvedLoggerSettings().maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
  });

  it("uses configured maxFileBytes", () => {
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 2048 });
    expect(getResolvedLoggerSettings().maxFileBytes).toBe(2048);
  });

  it("rotates file writes after cap is reached and keeps logging", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      () => true as unknown as ReturnType<typeof process.stderr.write>, // preserve stream contract in test spy
    );
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 256 });
    const logger = getLogger();

    logger.error(`network-failure-${"x".repeat(400)}`);
    logger.error("post-rotation-diagnostic");

    const currentContent = fs.readFileSync(logPath, "utf8");
    const archiveContent = fs.readFileSync(rotatedLogPath(logPath, 1), "utf8");
    expect(currentContent).toContain("post-rotation-diagnostic");
    expect(currentContent).not.toContain("network-failure");
    expect(archiveContent).toContain("network-failure");
    const rotationWarnings = stderrSpy.mock.calls
      .map(([firstArg]) => String(firstArg))
      .filter((line) => line.includes("log file rotation failed"));
    expect(rotationWarnings).toHaveLength(0);
  });

  it("keeps cached default rolling loggers on the current-day file", () => {
    const logDir = path.dirname(logPath);
    const firstDay = path.join(logDir, "openclaw-2026-01-01.log");
    const secondDay = path.join(logDir, "openclaw-2026-01-02.log");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T08:00:00Z"));
    setLoggerOverride({ level: "info", file: firstDay });
    const logger = getLogger();

    logger.info({ message: "first day" });
    vi.setSystemTime(new Date("2026-01-02T08:00:00Z"));
    logger.info({ message: "second day" });

    expect(fs.readFileSync(firstDay, "utf8")).toContain("first day");
    expect(fs.readFileSync(secondDay, "utf8")).toContain("second day");
    expect(fs.readFileSync(firstDay, "utf8")).not.toContain("second day");
  });
});
