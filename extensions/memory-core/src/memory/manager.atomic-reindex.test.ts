import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  moveMemoryIndexFiles,
  removeMemoryIndexFiles,
  runMemoryAtomicReindex,
} from "./manager-atomic-reindex.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  await expectRejectCode(fs.access(targetPath), "ENOENT");
}

async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe(code);
    return;
  }
  throw new Error(`Expected rejection with code ${code}`);
}

describe("memory manager atomic reindex", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let indexPath: string;
  let tempIndexPath: string;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-atomic-"));
  });

  beforeEach(async () => {
    const workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    indexPath = path.join(workspaceDir, "index.sqlite");
    tempIndexPath = `${indexPath}.tmp`;
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("keeps the prior index when a full reindex fails", async () => {
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");

    await expect(
      runMemoryAtomicReindex({
        targetPath: indexPath,
        tempPath: tempIndexPath,
        build: async () => {
          throw new Error("embedding failure");
        },
      }),
    ).rejects.toThrow("embedding failure");

    expect(readChunkMarker(indexPath)).toBe("before");
    await expectPathMissing(tempIndexPath);
  });

  it("replaces the old index after a successful temp reindex", async () => {
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");

    await runMemoryAtomicReindex({
      targetPath: indexPath,
      tempPath: tempIndexPath,
      build: async () => undefined,
    });

    expect(readChunkMarker(indexPath)).toBe("after");
    await expectPathMissing(tempIndexPath);
  });

  it("retries transient rename failures during index swaps", async () => {
    const rename = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
      .mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await moveMemoryIndexFiles("index.sqlite.tmp", "index.sqlite", {
      fileOps: { rename, rm: fs.rm, wait },
      maxRenameAttempts: 3,
      renameRetryDelayMs: 10,
    });

    expect(rename).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(10);
  });

  it("throws after retrying transient rename failures up to the attempt limit", async () => {
    const rename = vi.fn().mockRejectedValue(Object.assign(new Error("busy"), { code: "EBUSY" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expectRejectCode(
      moveMemoryIndexFiles("index.sqlite.tmp", "index.sqlite", {
        fileOps: { rename, rm: fs.rm, wait },
        maxRenameAttempts: 3,
        renameRetryDelayMs: 10,
      }),
      "EBUSY",
    );

    expect(rename).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 10);
    expect(wait).toHaveBeenNthCalledWith(2, 20);
  });

  it("does not retry missing optional sqlite sidecar files", async () => {
    const rename = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("missing wal"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("missing shm"), { code: "ENOENT" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await moveMemoryIndexFiles("index.sqlite.tmp", "index.sqlite", {
      fileOps: { rename, rm: fs.rm, wait },
      maxRenameAttempts: 3,
      renameRetryDelayMs: 10,
    });

    expect(rename).toHaveBeenCalledTimes(3);
    expect(wait).not.toHaveBeenCalled();
  });

  it("does not retry non-transient rename failures", async () => {
    const rename = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("invalid"), { code: "EINVAL" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expectRejectCode(
      moveMemoryIndexFiles("index.sqlite.tmp", "index.sqlite", {
        fileOps: { rename, rm: fs.rm, wait },
        maxRenameAttempts: 3,
        renameRetryDelayMs: 10,
      }),
      "EINVAL",
    );

    expect(rename).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it.each(["EBUSY", "EPERM", "EACCES"] as const)(
    "retries transient %s rm failures during index file cleanup",
    async (code) => {
      const calls: string[] = [];
      const rm: typeof fs.rm = vi.fn(async (filePath) => {
        calls.push(String(filePath));
        if (calls.length === 1) {
          throw Object.assign(new Error("busy"), { code });
        }
      });
      const wait = vi.fn().mockResolvedValue(undefined);

      await removeMemoryIndexFiles("index.sqlite.tmp", {
        fileOps: { rename: fs.rename, rm, wait },
        maxRemoveAttempts: 3,
        removeRetryDelayMs: 10,
      });

      expect(calls).toEqual([
        "index.sqlite.tmp",
        "index.sqlite.tmp",
        "index.sqlite.tmp-wal",
        "index.sqlite.tmp-shm",
      ]);
      expect(wait).toHaveBeenCalledTimes(1);
      expect(wait).toHaveBeenCalledWith(10);
    },
  );

  it("throws after exhausting transient rm retries", async () => {
    const rm = vi.fn().mockRejectedValue(Object.assign(new Error("busy"), { code: "EBUSY" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expectRejectCode(
      removeMemoryIndexFiles("index.sqlite.tmp", {
        fileOps: { rename: fs.rename, rm, wait },
        maxRemoveAttempts: 3,
        removeRetryDelayMs: 10,
      }),
      "EBUSY",
    );

    expect(rm).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 10);
    expect(wait).toHaveBeenNthCalledWith(2, 20);
  });

  it("does not retry non-transient rm failures", async () => {
    const rm = vi.fn().mockRejectedValue(Object.assign(new Error("invalid"), { code: "EINVAL" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expectRejectCode(
      removeMemoryIndexFiles("index.sqlite.tmp", {
        fileOps: { rename: fs.rename, rm, wait },
        maxRemoveAttempts: 3,
        removeRetryDelayMs: 10,
      }),
      "EINVAL",
    );

    expect(rm).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("closes temp resources before removing temp files after build failure", async () => {
    const events: string[] = [];
    let tempClosed = false;
    const rm: typeof fs.rm = vi.fn(async (filePath) => {
      events.push(tempClosed ? `rm:${String(filePath)}:closed` : `rm:${String(filePath)}:open`);
    });

    await expect(
      runMemoryAtomicReindex({
        targetPath: "index.sqlite",
        tempPath: "index.sqlite.tmp",
        beforeTempCleanup: async () => {
          events.push("close-temp");
          tempClosed = true;
        },
        fileOptions: {
          fileOps: { rename: fs.rename, rm, wait: vi.fn().mockResolvedValue(undefined) },
        },
        build: async () => {
          throw new Error("embedding failure");
        },
      }),
    ).rejects.toThrow("embedding failure");

    expect(events).toEqual([
      "close-temp",
      "rm:index.sqlite.tmp:closed",
      "rm:index.sqlite.tmp-wal:closed",
      "rm:index.sqlite.tmp-shm:closed",
    ]);
  });
});

function writeChunkMarker(dbPath: string, marker: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE chunks (id TEXT PRIMARY KEY, text TEXT NOT NULL)");
    db.prepare("INSERT INTO chunks (id, text) VALUES (?, ?)").run("chunk-1", marker);
  } finally {
    db.close();
  }
}

function readChunkMarker(dbPath: string): string | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db.prepare("SELECT text FROM chunks WHERE id = ?").get("chunk-1") as
        | { text: string }
        | undefined
    )?.text;
  } finally {
    db.close();
  }
}
