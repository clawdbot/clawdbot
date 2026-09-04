// Log file size cap tests cover truncation and rotation guards for log files.
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
import { testApi } from "./logger.test-support.js";

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

  it("rotates file writes after cap is reached and keeps logging", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 256 });
    const logger = getLogger();

    logger.error(`network-failure-${"x".repeat(400)}`);
    logger.error("post-rotation-diagnostic");
    await testApi.flushFileLogQueueForTests();

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

  it("structures rotation failure diagnostics for JSON console output", async () => {
    fs.writeFileSync(logPath, "seed");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rotation denied");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setLoggerOverride({
      level: "info",
      file: logPath,
      maxFileBytes: 1,
      consoleLevel: "info",
      consoleStyle: "json",
    });

    getLogger().error("rotation diagnostic");
    await testApi.flushFileLogQueueForTests();

    const warning = stderrSpy.mock.calls
      .map(([firstArg]) => String(firstArg))
      .find((line) => line.includes("log file rotation failed"));
    expect(JSON.parse(warning ?? "")).toMatchObject({
      level: "warn",
      message: expect.stringContaining("log file rotation failed"),
    });
  });

  it.each([
    { name: "default rolling", prefix: "openclaw", rolls: true },
    { name: "explicit profile-shaped", prefix: "openclaw-dev", rolls: false },
  ])(
    "keeps cached $name loggers on the expected files across date changes",
    async ({ prefix, rolls }) => {
      const logDir = path.dirname(logPath);
      const firstDay = path.join(logDir, `${prefix}-2026-01-01.log`);
      const secondDay = path.join(logDir, `${prefix}-2026-01-02.log`);
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T08:00:00Z"));
      setLoggerOverride({ level: "info", file: firstDay });
      const logger = getLogger();

      logger.info({ message: "first day" });
      vi.setSystemTime(new Date("2026-01-02T08:00:00Z"));
      logger.info({ message: "second day" });
      await testApi.flushFileLogQueueForTests();

      const firstContent = fs.readFileSync(firstDay, "utf8");
      expect(firstContent).toContain("first day");
      if (rolls) {
        expect(fs.readFileSync(secondDay, "utf8")).toContain("second day");
        expect(firstContent).not.toContain("second day");
      } else {
        expect(firstContent).toContain("second day");
        expect(fs.existsSync(secondDay)).toBe(false);
      }
    },
  );
});
