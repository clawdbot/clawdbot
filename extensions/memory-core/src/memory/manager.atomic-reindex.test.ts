import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { moveMemoryIndexFiles, runMemoryAtomicReindex } from "./manager-atomic-reindex.js";

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
    await expect(fs.access(tempIndexPath)).rejects.toThrow();
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
    await expect(fs.access(tempIndexPath)).rejects.toThrow();
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

    await expect(
      moveMemoryIndexFiles("index.sqlite.tmp", "index.sqlite", {
        fileOps: { rename, rm: fs.rm, wait },
        maxRenameAttempts: 3,
        renameRetryDelayMs: 10,
      }),
    ).rejects.toMatchObject({ code: "EBUSY" });

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
    const rename = vi.fn().mockRejectedValue(Object.assign(new Error("invalid"), { code: "EINVAL" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      moveMemoryIndexFiles("index.sqlite.tmp", "index.sqlite", {
        fileOps: { rename, rm: fs.rm, wait },
        maxRenameAttempts: 3,
        renameRetryDelayMs: 10,
      }),
    ).rejects.toMatchObject({ code: "EINVAL" });

    expect(rename).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
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
