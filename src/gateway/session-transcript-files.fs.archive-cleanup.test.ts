// Gateway tests cover archived-transcript retention cleanup: every retention
// rule shares one directory listing per cleanup call. Store maintenance runs
// this on each save, so per-rule listings would multiply READDIR load.
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupArchivedSessionTranscripts } from "./session-transcript-files.fs.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-06-02T00:00:00.000Z");
const OLD_STAMP = "2026-01-01T00-00-00.000Z";
const FRESH_STAMP = "2026-06-01T00-00-00.000Z";

describe("cleanupArchivedSessionTranscripts", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-archive-cleanup-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  async function seed(names: string[]): Promise<void> {
    for (const name of names) {
      await fsPromises.writeFile(path.join(dir, name), "");
    }
  }

  async function remaining(): Promise<string[]> {
    return (await fsPromises.readdir(dir)).toSorted();
  }

  function filesystemError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`filesystem ${code}`), { code });
  }

  it("applies every retention rule from a single directory listing", async () => {
    await seed([
      `a.jsonl.deleted.${OLD_STAMP}`,
      `b.jsonl.reset.${OLD_STAMP}`,
      `c.jsonl.reset.${FRESH_STAMP}`,
      "live.jsonl",
    ]);
    const readdirSpy = vi.spyOn(fsPromises, "readdir");

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [
        { reason: "deleted", olderThanMs: 30 * DAY_MS },
        { reason: "reset", olderThanMs: 30 * DAY_MS },
      ],
      nowMs: NOW_MS,
    });

    expect(readdirSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ removed: 2, scanned: 3 });
    expect(await remaining()).toEqual([`c.jsonl.reset.${FRESH_STAMP}`, "live.jsonl"]);
  });

  it("applies each rule's age threshold independently", async () => {
    await seed([`a.jsonl.deleted.${OLD_STAMP}`, `b.jsonl.reset.${OLD_STAMP}`]);

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [
        { reason: "deleted", olderThanMs: 30 * DAY_MS },
        { reason: "reset", olderThanMs: 365 * DAY_MS },
      ],
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ removed: 1, scanned: 2 });
    expect(await remaining()).toEqual([`b.jsonl.reset.${OLD_STAMP}`]);
  });

  it("keeps archives whose reason has no rule", async () => {
    await seed([`a.jsonl.reset.${OLD_STAMP}`]);

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [{ reason: "deleted", olderThanMs: 0 }],
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ removed: 0, scanned: 0 });
    expect(await remaining()).toEqual([`a.jsonl.reset.${OLD_STAMP}`]);
  });

  it("drops invalid rules and never lists when none remain", async () => {
    const readdirSpy = vi.spyOn(fsPromises, "readdir");

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [
        { reason: "deleted", olderThanMs: Number.NaN },
        { reason: "reset", olderThanMs: -1 },
      ],
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ removed: 0, scanned: 0 });
    expect(readdirSpy).not.toHaveBeenCalled();
  });

  it("ignores a missing archive directory", async () => {
    const result = await cleanupArchivedSessionTranscripts({
      directories: [path.join(dir, "missing")],
      rules: [{ reason: "deleted", olderThanMs: 0 }],
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ removed: 0, scanned: 0 });
  });

  it("surfaces archive directory read failures", async () => {
    const readError = filesystemError("EACCES");
    vi.spyOn(fsPromises, "readdir").mockRejectedValueOnce(readError);

    await expect(
      cleanupArchivedSessionTranscripts({
        directories: [dir],
        rules: [{ reason: "deleted", olderThanMs: 0 }],
        nowMs: NOW_MS,
      }),
    ).rejects.toBe(readError);
  });

  it("surfaces archive stat failures", async () => {
    await seed([`a.jsonl.deleted.${OLD_STAMP}`]);
    const statError = filesystemError("EIO");
    vi.spyOn(fsPromises, "stat").mockRejectedValueOnce(statError);

    await expect(
      cleanupArchivedSessionTranscripts({
        directories: [dir],
        rules: [{ reason: "deleted", olderThanMs: 0 }],
        nowMs: NOW_MS,
      }),
    ).rejects.toBe(statError);
  });

  it("ignores an archive removed between directory listing and stat", async () => {
    const archiveName = `a.jsonl.deleted.${OLD_STAMP}`;
    const archivePath = path.join(dir, archiveName);
    await seed([archiveName]);
    const realStat = fsPromises.stat.bind(fsPromises);
    vi.spyOn(fsPromises, "stat").mockImplementationOnce(async (target) => {
      await fsPromises.rm(target);
      return await realStat(target);
    });

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [{ reason: "deleted", olderThanMs: 0 }],
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ removed: 0, scanned: 1 });
    await expect(fsPromises.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces archive removal failures without deleting the archive", async () => {
    const archiveName = `a.jsonl.deleted.${OLD_STAMP}`;
    await seed([archiveName]);
    const removeError = filesystemError("EACCES");
    vi.spyOn(fsPromises, "rm").mockRejectedValueOnce(removeError);

    await expect(
      cleanupArchivedSessionTranscripts({
        directories: [dir],
        rules: [{ reason: "deleted", olderThanMs: 0 }],
        nowMs: NOW_MS,
      }),
    ).rejects.toBe(removeError);
    expect(await remaining()).toEqual([archiveName]);
  });

  it("does not count an archive removed between stat and cleanup", async () => {
    const archiveName = `a.jsonl.deleted.${OLD_STAMP}`;
    const archivePath = path.join(dir, archiveName);
    await seed([archiveName]);
    const realStat = fsPromises.stat.bind(fsPromises);
    vi.spyOn(fsPromises, "stat").mockImplementationOnce(async (target) => {
      const stat = await realStat(target);
      await fsPromises.rm(target);
      return stat;
    });

    const result = await cleanupArchivedSessionTranscripts({
      directories: [dir],
      rules: [{ reason: "deleted", olderThanMs: 0 }],
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ removed: 0, scanned: 1 });
    await expect(fsPromises.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
