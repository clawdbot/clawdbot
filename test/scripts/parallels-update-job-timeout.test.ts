// Parallels Update Job Timeout tests cover parallels update job timeout script behavior.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTimedUpdateJob } from "../../scripts/e2e/parallels/update-job-timeout.ts";

describe("Parallels update job timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes after the update body completes", async () => {
    const chunks: string[] = [];
    const writeLog = vi.fn(async () => undefined);

    await expect(
      runTimedUpdateJob({
        append: (chunk) => chunks.push(chunk),
        label: "macOS",
        run: async () => undefined,
        timeoutDescription: "1s",
        timeoutMs: 1000,
        writeLog,
      }),
    ).resolves.toBe(0);

    expect(chunks).toEqual([]);
    expect(writeLog).toHaveBeenCalledTimes(1);
  });

  it("clamps oversized update job timers before scheduling", async () => {
    const chunks: string[] = [];
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const writeLog = vi.fn(async () => undefined);

    try {
      await expect(
        runTimedUpdateJob({
          append: (chunk) => chunks.push(chunk),
          label: "Linux",
          run: async () => undefined,
          timeoutDescription: "oversized",
          timeoutMs: Number.MAX_SAFE_INTEGER,
          writeLog,
        }),
      ).resolves.toBe(0);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("records update failures and writes the job log", async () => {
    const chunks: string[] = [];
    const writeLog = vi.fn(async () => undefined);

    await expect(
      runTimedUpdateJob({
        append: (chunk) => chunks.push(chunk),
        label: "Linux",
        run: async () => {
          throw new Error("package swap failed");
        },
        timeoutDescription: "1s",
        timeoutMs: 1000,
        writeLog,
      }),
    ).resolves.toBe(1);

    expect(chunks).toEqual(["package swap failed\n"]);
    expect(writeLog).toHaveBeenCalledTimes(1);
  });

  it("lets the inner bounded operation settle before the backstop fires", async () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const writeLog = vi.fn(async () => undefined);

    const result = runTimedUpdateJob({
      append: (chunk) => chunks.push(chunk),
      label: "macOS",
      run: () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 1000);
        }),
      timeoutDescription: "1s plus cleanup backstop",
      timeoutMs: 1200,
      writeLog,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe(0);
    expect(chunks).toEqual([]);
    expect(writeLog).toHaveBeenCalledTimes(1);
  });

  it("fails and writes the job log when the update body hangs", async () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const writeLog = vi.fn(async () => undefined);

    const result = runTimedUpdateJob({
      abortSettleMs: 1,
      append: (chunk) => chunks.push(chunk),
      label: "Windows",
      run: () => new Promise(() => {}),
      timeoutDescription: "1s",
      timeoutMs: 1000,
      writeLog,
    });

    await vi.advanceTimersByTimeAsync(1001);
    await expect(result).resolves.toBe(1);
    expect(chunks).toEqual(["Windows update timed out after 1s\n"]);
    expect(writeLog).toHaveBeenCalledTimes(1);
  });

  it("aborts the update body when the timeout fires", async () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const writeLog = vi.fn(async () => undefined);
    let aborted = false;

    const result = runTimedUpdateJob({
      append: (chunk) => chunks.push(chunk),
      label: "Linux",
      run: ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        }),
      timeoutDescription: "1s plus cleanup backstop",
      timeoutMs: 1000,
      writeLog,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe(1);
    expect(aborted).toBe(true);
    expect(chunks).toEqual(["Linux update timed out after 1s plus cleanup backstop\n"]);
    expect(writeLog).toHaveBeenCalledTimes(1);
  });

  it("waits for abort-aware cleanup before writing the job log", async () => {
    vi.useFakeTimers();
    const events: string[] = [];

    const result = runTimedUpdateJob({
      abortSettleMs: 250,
      append: (chunk) => events.push(chunk.trim()),
      label: "macOS",
      run: ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              events.push("abort");
              setTimeout(() => {
                events.push("cleanup");
                resolve();
              }, 25);
            },
            { once: true },
          );
        }),
      timeoutDescription: "1s plus cleanup backstop",
      timeoutMs: 1000,
      writeLog: async () => {
        events.push("writeLog");
      },
    });

    await vi.advanceTimersByTimeAsync(1025);
    await expect(result).resolves.toBe(1);
    expect(events).toEqual([
      "macOS update timed out after 1s plus cleanup backstop",
      "abort",
      "cleanup",
      "writeLog",
    ]);
  });

  it("keeps the process alive long enough to write logs for hung runners", () => {
    const moduleUrl = pathToFileURL(
      path.resolve("scripts/e2e/parallels/update-job-timeout.ts"),
    ).href;
    const probe = `
import { runTimedUpdateJob } from ${JSON.stringify(moduleUrl)};
const events = [];
const result = await runTimedUpdateJob({
  abortSettleMs: 25,
  append: (chunk) => events.push(chunk.trim()),
  label: "Linux",
  run: () => new Promise(() => {}),
  timeoutDescription: "10ms",
  timeoutMs: 10,
  writeLog: async () => events.push("writeLog"),
});
console.log(JSON.stringify({ events, result }));
`;

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", probe],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 5_000,
      },
    );

    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      events: ["Linux update timed out after 10ms", "writeLog"],
      result: 1,
    });
  });
});
