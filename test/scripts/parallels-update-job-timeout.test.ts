// Parallels Update Job Timeout tests cover parallels update job timeout script behavior.
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
      append: (chunk) => chunks.push(chunk),
      label: "Windows",
      run: () => new Promise(() => {}),
      timeoutDescription: "1s",
      timeoutMs: 1000,
      writeLog,
    });

    await vi.advanceTimersByTimeAsync(1000);
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
});
