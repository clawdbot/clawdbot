import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TERMINAL_UPLOAD_BYTES,
  isCanonicalTerminalUploadBase64,
} from "../../packages/gateway-protocol/src/schema/terminal-constants.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureTerminalUploadCleanup, stageTerminalUpload } from "./terminal-file-upload.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const MARKER_NAME = ".openclaw-terminal-upload-v1";
const MARKER_CONTENT = "openclaw-terminal-upload-v1\n";

/** Writes one staged directory the way a previous process would have left it. */
async function writeStagedDirectory(
  directory: string,
  fileName: string,
  content: string,
  mtime: Date,
  options?: { marker?: boolean },
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (options?.marker !== false) {
    await writeFile(path.join(directory, MARKER_NAME), MARKER_CONTENT);
  }
  await writeFile(path.join(directory, fileName), content);
  await utimes(directory, mtime, mtime);
}

describe("terminal file upload", () => {
  it("stages arbitrary bytes under a private temporary directory", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-test-");
    const content = Buffer.from([0, 1, 2, 255]);

    const result = await stageTerminalUpload(
      { name: "../report final.pdf", contentBase64: content.toString("base64") },
      { tempRoot: root, cleanupAfterMs: 60_000 },
    );

    expect(path.basename(result.path)).toBe("report final.pdf");
    expect(result.path.startsWith(`${root}${path.sep}`)).toBe(true);
    expect(result.size).toBe(content.length);
    expect(await readFile(result.path)).toEqual(content);
    if (process.platform !== "win32") {
      expect((await stat(result.path)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(result.path))).mode & 0o777).toBe(0o700);
    }
  });

  it("uses the user-profile ACL boundary instead of a configurable Windows temp directory", async () => {
    const homeDir = tempDirs.make("openclaw-terminal-upload-windows-home-");
    const sharedTemp = tempDirs.make("openclaw-terminal-upload-windows-shared-");

    const result = await stageTerminalUpload(
      { name: "report.pdf", contentBase64: "" },
      { platform: "win32", homeDir, tempDir: sharedTemp },
    );

    expect(result.path.startsWith(path.join(homeDir, ".openclaw", "tmp"))).toBe(true);
    expect(result.path.startsWith(sharedTemp)).toBe(false);
  });

  it("normalizes hostile and oversized names", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-name-test-");
    const stagedName = async (name: string) =>
      path.basename(
        (
          await stageTerminalUpload(
            { name, contentBase64: "" },
            { tempRoot: root, cleanupAfterMs: 60_000 },
          )
        ).path,
      );

    expect(await stagedName("..\\..\\secret\u0000.txt")).toBe("secret_.txt");
    expect(await stagedName("report:<final>?!-%PATH%.pdf. ")).toBe("report__final___-_PATH_.pdf");
    expect(await stagedName("CON.txt")).toBe("_CON.txt");
    expect(await stagedName("COM¹.txt")).toBe("_COM¹.txt");
    expect(await stagedName("LPT³.log")).toBe("_LPT³.log");
    expect(Buffer.byteLength(await stagedName("🦞".repeat(100)), "utf8")).toBeLessThanOrEqual(180);
    expect(await stagedName("..")).toBe("upload");
  });

  it("recovers expired upload directories after restart", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-recovery-test-");
    const directory = path.join(root, "openclaw-terminal-upload-stale");
    await writeStagedDirectory(directory, "report.pdf", "stale", new Date(0));

    await ensureTerminalUploadCleanup({ tempRoot: root, retentionMs: 1, nowMs: Date.now() });

    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries a recovery scan after a transient root failure", async () => {
    vi.useFakeTimers();
    const parent = tempDirs.make("openclaw-terminal-upload-retry-test-");
    const root = path.join(parent, "root");
    const directory = path.join(root, "openclaw-terminal-upload-stale");
    try {
      await writeFile(root, "temporarily not a directory");
      await ensureTerminalUploadCleanup({ tempRoot: root, retentionMs: 1 });

      await rm(root);
      await writeStagedDirectory(directory, "report.pdf", "stale", new Date(0));

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await vi.waitFor(async () => {
        await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries partial upload cleanup without replacing the write error", async () => {
    vi.useFakeTimers();
    const root = tempDirs.make("openclaw-terminal-upload-write-failure-test-");
    const writeError = new Error("write failed");
    const writeMock = vi.mocked(writeFile);
    const rmMock = vi.mocked(rm);
    writeMock.mockClear();
    rmMock.mockClear();
    writeMock.mockRejectedValueOnce(writeError);
    rmMock.mockRejectedValueOnce(new Error("cleanup busy")).mockResolvedValueOnce(undefined);
    try {
      await expect(
        stageTerminalUpload({ name: "partial.bin", contentBase64: "AA==" }, { tempRoot: root }),
      ).rejects.toBe(writeError);
      expect(rmMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(rmMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed and oversized payloads", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-test-");
    expect(isCanonicalTerminalUploadBase64("AB==")).toBe(false);
    expect(isCanonicalTerminalUploadBase64("AAB=")).toBe(false);
    expect(isCanonicalTerminalUploadBase64("AA==")).toBe(true);
    await expect(
      stageTerminalUpload({ name: "bad.bin", contentBase64: "not base64" }, { tempRoot: root }),
    ).rejects.toThrow("invalid terminal upload encoding");
    await expect(
      stageTerminalUpload(
        {
          name: "large.bin",
          contentBase64: Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES + 1).toString("base64"),
        },
        { tempRoot: root },
      ),
    ).rejects.toThrow("exceeds");
  });

  it("rejects the 65th retained upload under the default directory budget", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-default-dir-bound-");
    const file = { name: "n.bin", contentBase64: Buffer.from("x").toString("base64") };
    for (let index = 0; index < 64; index += 1) {
      await stageTerminalUpload(file, { tempRoot: root, cleanupAfterMs: 60_000 });
    }
    await expect(
      stageTerminalUpload(file, { tempRoot: root, cleanupAfterMs: 60_000 }),
    ).rejects.toThrow("terminal upload staging limit reached");
    expect(
      (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()),
    ).toHaveLength(64);
  });

  it("writes the ownership marker before the payload and counts it against the byte budget", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-marker-");
    const file = { name: "data.bin", contentBase64: Buffer.from("data").toString("base64") };

    await expect(
      stageTerminalUpload(file, { tempRoot: root, cleanupAfterMs: 60_000, maxRetainedBytes: 4 }),
    ).rejects.toThrow("terminal upload staging limit reached");
    expect(await readdir(root)).toEqual([]);

    const result = await stageTerminalUpload(file, { tempRoot: root, cleanupAfterMs: 60_000 });
    const markerPath = path.join(path.dirname(result.path), MARKER_NAME);
    expect(await readFile(markerPath, "utf8")).toBe(MARKER_CONTENT);
    if (process.platform !== "win32") {
      expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("does not count, schedule, or remove unmarked directories that share the prefix", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-unmarked-");
    const foreign = path.join(root, "openclaw-terminal-upload-foreign");
    const staleTime = new Date(Date.now() - 10_000);
    await writeStagedDirectory(foreign, "keep.txt", "keep", staleTime, { marker: false });

    await ensureTerminalUploadCleanup({
      tempRoot: root,
      retentionMs: 1,
      nowMs: Date.now(),
      maxRetainedDirectories: 1,
    });
    expect(await readFile(path.join(foreign, "keep.txt"), "utf8")).toBe("keep");

    const file = { name: "n.bin", contentBase64: Buffer.from("x").toString("base64") };
    const first = await stageTerminalUpload(file, {
      tempRoot: root,
      cleanupAfterMs: 60_000,
      maxRetainedDirectories: 1,
    });
    await expect(
      stageTerminalUpload(file, {
        tempRoot: root,
        cleanupAfterMs: 60_000,
        maxRetainedDirectories: 1,
      }),
    ).rejects.toThrow("terminal upload staging limit reached");
    expect(await readFile(first.path, "utf8")).toBe("x");
    expect(await readFile(path.join(foreign, "keep.txt"), "utf8")).toBe("keep");
  });

  it("still accepts one file under the 16 MiB per-file limit", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-single-file-");
    const content = Buffer.alloc(1024, 7);

    const result = await stageTerminalUpload(
      { name: "notes.bin", contentBase64: content.toString("base64") },
      { tempRoot: root, cleanupAfterMs: 60_000 },
    );

    expect(result.size).toBe(content.length);
    expect(await readFile(result.path)).toEqual(content);
  });

  it("accepts an under-bound batch and rejects later files that would exceed it", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-batch-bound-");
    const file = (name: string, size: number) => ({
      name,
      contentBase64: Buffer.alloc(size, 9).toString("base64"),
    });

    // Each staged directory retains its 28-byte marker plus the 8-byte payload.
    const first = await stageTerminalUpload(file("a.bin", 8), {
      tempRoot: root,
      cleanupAfterMs: 60_000,
      maxRetainedBytes: 100,
      maxRetainedDirectories: 2,
    });
    const second = await stageTerminalUpload(file("b.bin", 8), {
      tempRoot: root,
      cleanupAfterMs: 60_000,
      maxRetainedBytes: 100,
      maxRetainedDirectories: 2,
    });

    await expect(
      stageTerminalUpload(file("c.bin", 8), {
        tempRoot: root,
        cleanupAfterMs: 60_000,
        maxRetainedBytes: 100,
        maxRetainedDirectories: 2,
      }),
    ).rejects.toThrow("terminal upload staging limit reached");

    expect(await readFile(first.path)).toHaveLength(8);
    expect(await readFile(second.path)).toHaveLength(8);
    expect(
      (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()),
    ).toHaveLength(2);
  });

  it("rejects a file that is under 16 MiB when retained bytes would exceed the budget", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-byte-bound-");
    // 12 payload bytes plus the 28-byte marker retain 40 bytes per directory.
    const first = await stageTerminalUpload(
      { name: "kept.bin", contentBase64: Buffer.alloc(12, 3).toString("base64") },
      { tempRoot: root, cleanupAfterMs: 60_000, maxRetainedBytes: 70, maxRetainedDirectories: 10 },
    );

    await expect(
      stageTerminalUpload(
        { name: "overflow.bin", contentBase64: Buffer.alloc(12, 4).toString("base64") },
        {
          tempRoot: root,
          cleanupAfterMs: 60_000,
          maxRetainedBytes: 70,
          maxRetainedDirectories: 10,
        },
      ),
    ).rejects.toThrow("terminal upload staging limit reached");
    expect(await readFile(first.path)).toHaveLength(12);
  });

  it("enforces the retained directory budget across concurrent uploads", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-concurrent-");
    const file = {
      name: "report.bin",
      contentBase64: Buffer.from("data").toString("base64"),
    };

    const results = await Promise.allSettled([
      stageTerminalUpload(file, {
        tempRoot: root,
        cleanupAfterMs: 60_000,
        maxRetainedBytes: 1024,
        maxRetainedDirectories: 1,
      }),
      stageTerminalUpload(file, {
        tempRoot: root,
        cleanupAfterMs: 60_000,
        maxRetainedBytes: 1024,
        maxRetainedDirectories: 1,
      }),
    ]);

    expect(results.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        message: "terminal upload staging limit reached",
      }),
    });
    expect(
      (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()),
    ).toHaveLength(1);
  });

  it("evicts the oldest retained directory during restart recovery when over quota", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-recovery-quota-");
    const oldestDirectory = path.join(root, "openclaw-terminal-upload-oldest");
    const newestDirectory = path.join(root, "openclaw-terminal-upload-newest");
    const now = Date.now();
    await writeStagedDirectory(oldestDirectory, "old.bin", "old", new Date(now - 2_000));
    await writeStagedDirectory(newestDirectory, "new.bin", "new", new Date(now - 1_000));

    await ensureTerminalUploadCleanup({
      tempRoot: root,
      nowMs: now,
      maxRetainedBytes: 100,
      maxRetainedDirectories: 1,
    });

    await expect(stat(oldestDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(newestDirectory, "new.bin"), "utf8")).toBe("new");
  });
});
