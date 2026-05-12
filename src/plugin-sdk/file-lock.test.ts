import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireFileLock,
  drainFileLockStateForTest,
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  resetFileLockStateForTest,
} from "./file-lock.js";

describe("acquireFileLock", () => {
  let tempDir = "";

  beforeEach(async () => {
    resetFileLockStateForTest();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-file-lock-"));
  });

  afterEach(async () => {
    await drainFileLockStateForTest();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("respects the configured retry budget even when stale windows are much larger", async () => {
    const filePath = path.join(tempDir, "oauth-refresh");
    const lockPath = `${filePath}.lock`;
    const options = {
      retries: {
        retries: 1,
        factor: 1,
        minTimeout: 20,
        maxTimeout: 20,
      },
      stale: 100,
    } as const;

    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
      "utf8",
    );

    let caught: { code?: string; lockPath?: string } | undefined;
    try {
      await acquireFileLock(filePath, options);
    } catch (error) {
      caught = error as { code?: string; lockPath?: string };
    }
    expect(caught?.code).toBe(FILE_LOCK_TIMEOUT_ERROR_CODE);
    expect(caught?.lockPath ? path.relative(await fs.realpath(tempDir), caught.lockPath) : "").toBe(
      "oauth-refresh.lock",
    );
  }, 5_000);

  it("closes an opened lock handle when writing the owner payload fails", async () => {
    const filePath = path.join(tempDir, "write-fails");
    const writeError = new Error("owner write failed");
    const close = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(fs, "open").mockResolvedValue({
      close,
      writeFile: vi.fn().mockRejectedValue(writeError),
    } as unknown as Awaited<ReturnType<typeof fs.open>>);

    await expect(
      acquireFileLock(filePath, {
        retries: {
          retries: 0,
          factor: 1,
          minTimeout: 1,
          maxTimeout: 1,
        },
        stale: 100,
      }),
    ).rejects.toThrow(writeError);

    expect(close).toHaveBeenCalledTimes(1);
  });
});
