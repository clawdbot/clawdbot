// Logger file transport tests cover async ordering, overflow, and exit durability.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { appendRegularFile } from "../infra/regular-file.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { fileLogTransport } from "./logger-file-transport.js";
import { getLogger, resetLogger, setLoggerOverride } from "./logger.js";
import { testApi } from "./logger.test-support.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";

const logPathTracker = createSuiteLogPathTracker("openclaw-file-transport-");

function writeStableRecords(): void {
  const logger = getLogger();
  logger.info({ sequence: 1 }, "first queued record");
  logger.info({ sequence: 2 }, "second queued record");
}

beforeAll(async () => {
  await logPathTracker.setup();
});

afterEach(async () => {
  await testApi.flushFileLogQueueForTests();
  testApi.resetFileLogTransportForTests();
  resetLogger();
  setLoggerOverride(null);
  resetSecretRedactionRegistryForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await logPathTracker.cleanup();
});

describe("async logger file transport", () => {
  it("installs process hooks only while file logging is active", () => {
    const beforeExitListeners = process.listenerCount("beforeExit");
    const exitListeners = process.listenerCount("exit");
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });

    expect(process.listenerCount("beforeExit")).toBe(beforeExitListeners);
    expect(process.listenerCount("exit")).toBe(exitListeners);

    getLogger().info("install-file-transport-hooks");

    expect(process.listenerCount("beforeExit")).toBe(beforeExitListeners + 1);
    expect(process.listenerCount("exit")).toBe(exitListeners + 1);

    testApi.resetFileLogTransportForTests();

    expect(process.listenerCount("beforeExit")).toBe(beforeExitListeners);
    expect(process.listenerCount("exit")).toBe(exitListeners);
  });

  it("writes queued records in order and byte-identically to the synchronous drain", async () => {
    const syncPath = logPathTracker.nextPath();
    const asyncPath = logPathTracker.nextPath();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    testApi.setHostnameResolverForTests(() => "transport-test-host");
    setLoggerOverride({ level: "info", file: syncPath });

    writeStableRecords();
    testApi.drainFileLogQueueSyncForTests();
    const syncBytes = fs.readFileSync(syncPath);

    resetLogger();
    testApi.setHostnameResolverForTests(() => "transport-test-host");
    setLoggerOverride({ level: "info", file: asyncPath });
    writeStableRecords();
    await testApi.flushFileLogQueueForTests();

    expect(fs.readFileSync(asyncPath)).toEqual(syncBytes);
    const messages = syncBytes
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { message?: string }).message);
    expect(messages).toEqual(["first queued record", "second queued record"]);
  });

  it("drops the oldest records on overflow and writes one count marker", async () => {
    const logPath = logPathTracker.nextPath();
    testApi.setFileLogQueueMaxRecordsForTests(3);
    setLoggerOverride({ level: "info", file: logPath });

    for (let index = 1; index <= 5; index += 1) {
      getLogger().info(`queued-record-${index}`);
    }
    await testApi.flushFileLogQueueForTests();

    const records = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message?: string; dropped?: number });
    const markers = records.filter((record) => record.message?.includes("queue overflow"));
    expect(markers).toEqual([
      expect.objectContaining({
        dropped: 2,
        message: "[openclaw] file log queue overflow; dropped 2 oldest records",
      }),
    ]);
    expect(records.map((record) => record.message)).toEqual([
      "[openclaw] file log queue overflow; dropped 2 oldest records",
      "queued-record-3",
      "queued-record-4",
      "queued-record-5",
    ]);
  });

  it("drains bursts with bounded secured appends while preserving every record", async () => {
    const logPath = logPathTracker.nextPath();
    const appended: string[] = [];
    testApi.setFileLogAppenderForTests(async (options) => {
      appended.push(String(options.content));
      await appendRegularFile(options);
    });
    setLoggerOverride({ level: "info", file: logPath });
    const messages = Array.from({ length: 128 }, (_, index) => `${index}:${"🦞".repeat(256)}`);

    for (const message of messages) {
      getLogger().info(message);
    }
    await testApi.flushFileLogQueueForTests();

    expect(appended.length).toBeLessThan(16);
    expect(appended.every((content) => Buffer.byteLength(content) <= 64 * 1024)).toBe(true);
    expect(
      fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).message),
    ).toEqual(messages);
  });

  it.each(["async", "sync"])(
    "preserves rotation and target boundaries in %s batches",
    async (mode) => {
      const firstPath = logPathTracker.nextPath();
      const secondPath = logPathTracker.nextPath();
      const payloads = [1, 2, 3, 4, 5, "x".repeat(128), 7].map(
        (value) => `${JSON.stringify(value)}\n`,
      );
      for (const [index, payload] of payloads.entries()) {
        fileLogTransport.enqueue({
          file: index === 3 ? secondPath : firstPath,
          hostname: "transport-test-host",
          maxFileBytes: index === 2 ? 4 : 64,
          payload,
        });
      }
      if (mode === "async") {
        await fileLogTransport.flush();
      } else {
        fileLogTransport.drainSync();
      }

      expect(fs.readFileSync(firstPath, "utf8")).toBe(payloads[6]);
      expect(fs.readFileSync(firstPath.replace(/\.log$/, ".1.log"), "utf8")).toBe(payloads[5]);
      expect(fs.readFileSync(firstPath.replace(/\.log$/, ".2.log"), "utf8")).toBe(
        [payloads[2], payloads[4]].join(""),
      );
      expect(fs.readFileSync(firstPath.replace(/\.log$/, ".3.log"), "utf8")).toBe(
        payloads.slice(0, 2).join(""),
      );
      expect(fs.readFileSync(secondPath, "utf8")).toBe(payloads[3]);
    },
  );

  it("rescues the unissued tail without replaying an in-flight batch", async () => {
    const logPath = logPathTracker.nextPath();
    const issued = createDeferred();
    const release = createDeferred();
    let issuedRecords = 0;
    testApi.setFileLogAppenderForTests(async (options) => {
      await appendRegularFile(options);
      issuedRecords = String(options.content).trim().split("\n").length;
      issued.resolve();
      await release.promise;
    });
    const entries = Array.from({ length: 4 }, (_, index) => ({
      file: logPath,
      hostname: "transport-test-host",
      maxFileBytes: 1024 * 1024,
      payload: `${JSON.stringify({ index, text: "x".repeat(20_000) })}\n`,
    }));
    for (const entry of entries) {
      fileLogTransport.enqueue(entry);
    }
    const flushing = fileLogTransport.flush();
    try {
      await issued.promise;
      expect(issuedRecords).toBeGreaterThan(1);
      fileLogTransport.enqueue({
        file: logPath,
        hostname: "transport-test-host",
        maxFileBytes: 1024 * 1024,
        payload: '{"index":4}\n',
      });
      fileLogTransport.drainSync();
    } finally {
      release.resolve();
      await flushing;
    }

    expect(
      fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).index),
    ).toEqual([0, 1, 2, 3, 4]);
    expect(entries.every((entry) => entry.payload === "")).toBe(true);
  });

  it("keeps later exit records separate after a synchronous short write", () => {
    const logPath = logPathTracker.nextPath();
    for (const payload of ["first\n", "second\n"]) {
      fileLogTransport.enqueue({
        file: logPath,
        hostname: "transport-test-host",
        maxFileBytes: 1024,
        payload,
      });
    }
    vi.spyOn(fs, "writeSync").mockReturnValueOnce(0);

    fileLogTransport.drainSync();

    expect(fs.readFileSync(logPath, "utf8")).toContain("second\n");
  });

  for (const kind of ["symlink", "hardlink"]) {
    it.skipIf(kind === "symlink" && process.platform === "win32")(
      `rejects ${kind} targets for batched appends`,
      async () => {
        const target = logPathTracker.nextPath();
        const logPath = logPathTracker.nextPath();
        fs.writeFileSync(target, "untouched");
        if (kind === "symlink") {
          fs.symlinkSync(target, logPath);
        } else {
          fs.linkSync(target, logPath);
        }
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        setLoggerOverride({ level: "info", file: logPath });
        writeStableRecords();
        await fileLogTransport.flush();

        expect(fs.readFileSync(target, "utf8")).toBe("untouched");
        expect(
          stderr.mock.calls.filter(([line]) => String(line).includes("log file append failed")),
        ).toHaveLength(1);
      },
    );
  }

  it("warns once per append failure streak and continues with later batches", async () => {
    const secret = "append-warning-secret-1234567890";
    registerSecretValueForRedaction(secret);
    const logPath = `${logPathTracker.nextPath()}-${secret}`;
    let appendAttempts = 0;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    testApi.setFileLogAppenderForTests(async (options) => {
      appendAttempts += 1;
      if (appendAttempts !== 3) {
        throw new Error("injected append failure");
      }
      await appendRegularFile(options);
    });
    setLoggerOverride({ level: "info", file: logPath });

    getLogger().info("first-dropped-record");
    getLogger().info("first-dropped-companion");
    await testApi.flushFileLogQueueForTests();
    getLogger().info("second-dropped-record");
    getLogger().info("second-dropped-companion");
    await testApi.flushFileLogQueueForTests();
    getLogger().info("written-after-failure");
    getLogger().info("written-companion-after-failure");
    await testApi.flushFileLogQueueForTests();
    getLogger().info("dropped-after-recovery");
    getLogger().info("dropped-companion-after-recovery");
    await testApi.flushFileLogQueueForTests();

    const content = fs.readFileSync(logPath, "utf8");
    expect(appendAttempts).toBe(4);
    expect(content).not.toContain("first-dropped-record");
    expect(content).toContain("written-after-failure");
    expect(content).toContain("written-companion-after-failure");
    expect(content).not.toContain("dropped-after-recovery");
    const warnings = stderrSpy.mock.calls.map(([line]) => String(line));
    expect(warnings.filter((line) => line.includes("log file append failed"))).toHaveLength(2);
    expect(warnings[0]).toContain(
      "records dropped; check that the path is a writable regular file",
    );
    expect(warnings.join("\n")).not.toContain(secret);
  });

  it("keeps failure streaks independent by file", async () => {
    const firstPath = logPathTracker.nextPath();
    const secondPath = logPathTracker.nextPath();
    fs.mkdirSync(firstPath);
    fs.mkdirSync(secondPath);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    setLoggerOverride({ level: "info", file: firstPath });
    getLogger().info("first-file-failure");
    setLoggerOverride({ level: "info", file: secondPath });
    getLogger().info("second-file-failure");
    await testApi.flushFileLogQueueForTests();

    fs.rmdirSync(secondPath);
    getLogger().info("second-file-recovery");
    setLoggerOverride({ level: "info", file: firstPath });
    getLogger().info("first-file-repeated-failure");
    await testApi.flushFileLogQueueForTests();

    const warnings = stderrSpy.mock.calls.map(([line]) => String(line));
    expect(warnings.filter((line) => line.includes(`file=${firstPath}`))).toHaveLength(1);
    expect(warnings.filter((line) => line.includes(`file=${secondPath}`))).toHaveLength(1);
    expect(fs.readFileSync(secondPath, "utf8")).toContain("second-file-recovery");
  });

  it("writes a piped append warning before process exit", () => {
    const logPath = logPathTracker.nextPath();
    fs.mkdirSync(logPath);
    const loaderPath = fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url));
    const loggerUrl = new URL("./logger.ts", import.meta.url).href;
    const script = `
      import { getLogger, setLoggerOverride } from ${JSON.stringify(loggerUrl)};
      const writeStderr = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, ...args) => {
        setImmediate(() => writeStderr(chunk, ...args));
        return true;
      };
      setLoggerOverride({ level: "info", file: ${JSON.stringify(logPath)}, consoleStyle: "compact" });
      getLogger().info("exit-dropped-record");
      process.exit(0);
    `;

    const result = spawnSync(
      process.execPath,
      ["--import", loaderPath, "--input-type=module", "--eval", script],
      {
        encoding: "utf8",
        env: { ...process.env, VITEST: "false" },
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("log file append failed; records dropped");
  });

  it("retries the warning after stderr rejects it", async () => {
    const logPath = logPathTracker.nextPath();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stderrSpy.mockImplementationOnce(() => {
      throw new Error("injected stderr failure");
    });
    testApi.setFileLogAppenderForTests(async () => {
      throw new Error("injected append failure");
    });
    setLoggerOverride({ level: "info", file: logPath });

    getLogger().info("first-dropped-record");
    await testApi.flushFileLogQueueForTests();
    getLogger().info("second-dropped-record");
    await testApi.flushFileLogQueueForTests();

    expect(stderrSpy).toHaveBeenCalledTimes(2);
    expect(String(stderrSpy.mock.calls[1]?.[0])).toContain(`file=${logPath}`);
  });

  it("releases saturated failure tracking after a tracked file recovers", async () => {
    const firstPath = logPathTracker.nextPath();
    const lastPath = logPathTracker.nextPath();
    const paths = [
      firstPath,
      ...Array.from({ length: 63 }, () => logPathTracker.nextPath()),
      lastPath,
    ];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    testApi.setFileLogAppenderForTests(async () => {
      throw new Error("injected append failure");
    });

    for (const [index, file] of paths.entries()) {
      setLoggerOverride({ level: "info", file });
      getLogger().info(`failure-${index}`);
    }
    await testApi.flushFileLogQueueForTests();

    const warnings = stderrSpy.mock.calls.map(([line]) => String(line));
    expect(warnings.filter((line) => line.includes("diagnostics saturated"))).toHaveLength(1);
    expect(warnings.some((line) => line.includes(`file=${lastPath}`))).toBe(false);

    testApi.setFileLogAppenderForTests(async (options) => {
      if (options.filePath === firstPath) {
        await appendRegularFile(options);
        return;
      }
      throw new Error("injected append failure");
    });
    setLoggerOverride({ level: "info", file: firstPath });
    getLogger().info("tracked-file-recovery");
    setLoggerOverride({ level: "info", file: lastPath });
    getLogger().info("newly-tracked-failure");
    await testApi.flushFileLogQueueForTests();

    expect(stderrSpy.mock.calls.some(([line]) => String(line).includes(`file=${lastPath}`))).toBe(
      true,
    );
  });

  it("synchronously drains a crash-adjacent fatal record through the exit-hook seam", () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });

    getLogger().fatal("fatal-before-exit");
    expect(fs.existsSync(logPath)).toBe(false);
    testApi.drainFileLogQueueSyncForTests();

    expect(fs.readFileSync(logPath, "utf8")).toContain("fatal-before-exit");
  });
});
