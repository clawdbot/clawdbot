import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
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
    lstat: vi.fn(actual.lstat),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const storageLimitBytes = 256 * 1024 * 1024;
const directoryLimit = 64;

async function createRetainedUploads(root: string, sizes: number[]): Promise<string[]> {
  return Promise.all(
    sizes.map(async (size, index) => {
      const directory = path.join(root, `openclaw-terminal-upload-retained-${index}`);
      const file = path.join(directory, "retained.bin");
      await mkdir(directory, { mode: 0o700 });
      await writeFile(file, "");
      if (size > 0) {
        await truncate(file, size);
      }
      return file;
    }),
  );
}

async function retainedDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("openclaw-terminal-upload-"))
    .map((entry) => entry.name);
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

  it.each([
    { name: "an empty lock", payload: "" },
    { name: "a partial lock", payload: '{"pid":' },
    { name: "an orphaned reclaim guard", payload: null },
  ])("protects shared-root locks and recovers safely from $name", async ({ payload }) => {
    const root = tempDirs.make("openclaw-terminal-upload-private-lock-test-");
    if (process.platform !== "win32") {
      await chmod(root, 0o1777);
    }
    const initial = await stageTerminalUpload(
      { name: "accepted.bin", contentBase64: "AA==" },
      { tempRoot: root },
    );
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const lockDirectories = entries.filter(
      (entry) => entry.isDirectory() && entry.name === "terminal-upload-lock",
    );
    expect(lockDirectories).toHaveLength(1);

    for (const entry of lockDirectories) {
      const lockDirectory = path.join(entry.parentPath, entry.name);
      if (process.platform !== "win32") {
        expect((await stat(root)).mode & 0o7777).toBe(0o1777);
        expect((await stat(entry.parentPath)).mode & 0o777).toBe(0o700);
        expect((await stat(lockDirectory)).mode & 0o777).toBe(0o700);
      }
      const lockPath = path.join(lockDirectory, "admission.lock");
      if (payload === null) {
        await mkdir(`${lockPath}.reclaim`, { mode: 0o700 });
      } else {
        await writeFile(lockPath, payload, { flag: "wx", mode: 0o600 });
      }

      const failure = await stageTerminalUpload(
        { name: "blocked.bin", contentBase64: "AA==" },
        { tempRoot: root },
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        message: expect.stringContaining("Stop all Gateway and node-host processes"),
      });
      expect(failure).toMatchObject({
        message: expect.stringContaining(path.relative(root, lockDirectory)),
      });
      expect(failure).toMatchObject({ message: expect.not.stringContaining(lockDirectory) });
      expect(failure).toMatchObject({
        message: expect.stringContaining("remove only this lock directory"),
      });
      expect(failure).toMatchObject({
        message: expect.stringContaining(
          process.platform === "win32"
            ? "home directory of the account running this terminal's Gateway or node host"
            : "system temporary directory used by this terminal's Gateway or node-host process",
        ),
      });
      expect(failure).toMatchObject({ message: expect.stringContaining("then restart them") });
      expect(await retainedDirectories(root)).toHaveLength(1);
      expect(await readFile(initial.path)).toEqual(Buffer.from([0]));
      if (payload === null) {
        expect((await stat(`${lockPath}.reclaim`)).isDirectory()).toBe(true);
      } else {
        expect(await readFile(lockPath, "utf8")).toBe(payload);
      }

      await rm(lockDirectory, { recursive: true, force: true });
      const recovered = await stageTerminalUpload(
        { name: "after-recovery.bin", contentBase64: "AQ==" },
        { tempRoot: root },
      );
      expect(await readFile(recovered.path)).toEqual(Buffer.from([1]));
      expect(await readFile(initial.path)).toEqual(Buffer.from([0]));
      expect(await retainedDirectories(root)).toHaveLength(2);
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "retries a finished upload's lock release after directory permissions recover",
    async () => {
      const root = tempDirs.make("openclaw-terminal-upload-release-test-");
      const writeMock = vi.mocked(writeFile);
      let lockDirectory = "";
      let writtenPath = "";
      writeMock.mockImplementation(async (target, data, options) => {
        await actualFs.writeFile(target, data, options);
        if (typeof target !== "string" || path.basename(target) !== "first.bin") {
          return;
        }
        writtenPath = target;
        const entries = await readdir(root, { recursive: true, withFileTypes: true });
        const lock = entries.find(
          (entry) => entry.isDirectory() && entry.name === "terminal-upload-lock",
        );
        if (!lock) {
          throw new Error("the upload must hold its staging lock before writing");
        }
        lockDirectory = path.join(lock.parentPath, lock.name);
        await chmod(lockDirectory, 0o500);
      });
      try {
        await expect(
          stageTerminalUpload({ name: "first.bin", contentBase64: "AA==" }, { tempRoot: root }),
        ).rejects.toMatchObject({ code: "EACCES" });
        expect(await readFile(writtenPath)).toEqual(Buffer.from([0]));

        writeMock.mockImplementation(actualFs.writeFile);
        await chmod(lockDirectory, 0o700);
        const recovered = await stageTerminalUpload(
          { name: "second.bin", contentBase64: "AQ==" },
          { tempRoot: root },
        );

        expect(await readFile(recovered.path)).toEqual(Buffer.from([1]));
        expect(await readFile(writtenPath)).toEqual(Buffer.from([0]));
        expect(await retainedDirectories(root)).toHaveLength(2);
        await expect(stat(path.join(lockDirectory, "admission.lock"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        writeMock.mockImplementation(actualFs.writeFile);
        if (lockDirectory) {
          await chmod(lockDirectory, 0o700);
        }
      }
    },
  );

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
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, "report.pdf"), "stale");
    await utimes(directory, new Date(0), new Date(0));

    await ensureTerminalUploadCleanup({ tempRoot: root, retentionMs: 1, nowMs: Date.now() });

    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([1, directoryLimit + 1])(
    "keeps the original recovered expiry after renames in %i upload directories",
    async (count) => {
      vi.useFakeTimers({ now: Date.now() + 60_000 });
      const root = tempDirs.make("openclaw-terminal-upload-rename-recovery-test-");
      const remainingMs = 2 * 60 * 60 * 1000;
      try {
        const files = await createRetainedUploads(
          root,
          Array.from({ length: count }, () => 0),
        );
        const originalTime = new Date(Date.now() - 22 * 60 * 60 * 1000);
        await Promise.all(
          files.map((file) => utimes(path.dirname(file), originalTime, originalTime)),
        );
        await ensureTerminalUploadCleanup({ tempRoot: root });

        const renamed = files.map((file) => path.join(path.dirname(file), "renamed.bin"));
        await Promise.all(files.map((file, index) => rename(file, renamed[index]!)));
        await vi.advanceTimersByTimeAsync(remainingMs - 1);
        expect(await retainedDirectories(root)).toHaveLength(count);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(1);

        await vi.waitFor(async () => {
          expect(await retainedDirectories(root)).toHaveLength(0);
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { identity: "native", largeFileIds: false },
    { identity: "64-bit", largeFileIds: true },
  ])(
    "gives a replacement directory its own expiry with $identity file identifiers",
    async ({ largeFileIds }) => {
      vi.useFakeTimers({ now: Date.now() + 60_000 });
      const root = tempDirs.make("openclaw-terminal-upload-replacement-recovery-test-");
      const directory = path.join(root, "openclaw-terminal-upload-replaced");
      const movedDirectory = path.join(root, "operator-kept");
      const retentionMs = 24 * 60 * 60 * 1000;
      const remainingMs = 2 * 60 * 60 * 1000;
      const lstatMock = vi.mocked(lstat);
      let inode = 2n ** 54n;
      try {
        if (largeFileIds) {
          lstatMock.mockImplementation(async (target, options) => {
            const stats = await actualFs.lstat(target, options);
            if (String(target) === directory) {
              stats.ino = typeof stats.ino === "bigint" ? inode : Number(inode);
            }
            return stats;
          });
        }
        await mkdir(directory, { mode: 0o700 });
        await writeFile(path.join(directory, "original.bin"), "keep outside staging");
        const originalTime = new Date(Date.now() - retentionMs + remainingMs);
        await utimes(directory, originalTime, originalTime);
        await ensureTerminalUploadCleanup({ tempRoot: root });

        await rename(directory, movedDirectory);
        inode += 1n;
        await mkdir(directory, { mode: 0o700 });
        await writeFile(path.join(directory, "replacement.bin"), "new upload directory");
        const replacementTime = new Date(Date.now());
        await utimes(directory, replacementTime, replacementTime);
        await vi.advanceTimersByTimeAsync(remainingMs);
        await ensureTerminalUploadCleanup({ tempRoot: root });

        expect(await readFile(path.join(directory, "replacement.bin"), "utf8")).toBe(
          "new upload directory",
        );
        await vi.advanceTimersByTimeAsync(retentionMs - remainingMs);
        await vi.waitFor(async () => {
          await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
        });
        expect(await readFile(path.join(movedDirectory, "original.bin"), "utf8")).toBe(
          "keep outside staging",
        );
      } finally {
        lstatMock.mockImplementation(actualFs.lstat);
        vi.useRealTimers();
      }
    },
  );

  it("expires a future-dated upload without extending retention on each recovery scan", async () => {
    const nowMs = Date.UTC(2026, 8, 7, 12);
    const retentionMs = 1_000;
    vi.useFakeTimers({ now: nowMs });
    const root = tempDirs.make("openclaw-terminal-upload-future-recovery-test-");
    const directory = path.join(root, "openclaw-terminal-upload-future");
    try {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(path.join(directory, "retained.bin"), "keep until expiry");
      const future = new Date(nowMs + 2 ** 31 + retentionMs);
      await utimes(directory, future, future);

      await ensureTerminalUploadCleanup({ tempRoot: root, retentionMs });

      expect((await stat(directory)).mtimeMs).toBe(nowMs);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(retentionMs / 2);
      await ensureTerminalUploadCleanup({ tempRoot: root, retentionMs });
      expect((await stat(directory)).mtimeMs).toBe(nowMs);
      expect(await readFile(path.join(directory, "retained.bin"), "utf8")).toBe(
        "keep until expiry",
      );

      await vi.advanceTimersByTimeAsync(retentionMs / 2);
      await vi.waitFor(async () => {
        await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      });
      await ensureTerminalUploadCleanup({ tempRoot: root, retentionMs });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(retentionMs * 2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits only the last available directory across simultaneous uploads after restart", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-count-test-");
    await createRetainedUploads(
      root,
      Array.from({ length: directoryLimit - 1 }, () => 0),
    );

    const results = await Promise.allSettled(
      ["first.bin", "second.bin"].map((name) =>
        stageTerminalUpload({ name, contentBase64: "" }, { tempRoot: root }),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      stageTerminalUpload({ name: "overflow.bin", contentBase64: "" }, { tempRoot: root }),
    ).rejects.toThrow();
    expect(await retainedDirectories(root)).toHaveLength(directoryLimit);
  });

  it("enforces the retained byte budget independently of the directory budget", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-bytes-test-");
    const sizes = Array.from(
      { length: storageLimitBytes / MAX_TERMINAL_UPLOAD_BYTES },
      (_, index) => (index === 0 ? MAX_TERMINAL_UPLOAD_BYTES - 1 : MAX_TERMINAL_UPLOAD_BYTES),
    );
    await createRetainedUploads(root, sizes);

    const lastByte = await stageTerminalUpload(
      { name: "last-byte.bin", contentBase64: "AA==" },
      { tempRoot: root },
    );

    expect(await readFile(lastByte.path)).toEqual(Buffer.from([0]));
    await expect(
      stageTerminalUpload({ name: "overflow.bin", contentBase64: "AA==" }, { tempRoot: root }),
    ).rejects.toThrow();
    const empty = await stageTerminalUpload(
      { name: "empty.bin", contentBase64: "" },
      { tempRoot: root },
    );
    expect(await readFile(empty.path)).toEqual(Buffer.alloc(0));
    expect(await retainedDirectories(root)).toHaveLength(sizes.length + 2);
  });

  it("keeps partially removed expired uploads charged and retries at the original deadline", async () => {
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    const root = tempDirs.make("openclaw-terminal-upload-cleanup-budget-test-");
    const files = await createRetainedUploads(
      root,
      Array.from({ length: directoryLimit }, () => storageLimitBytes / directoryLimit),
    );
    const expiredFile = files[0]!;
    const expiredDirectory = path.dirname(expiredFile);
    const removableFile = path.join(expiredDirectory, "removed-before-failure.bin");
    await writeFile(removableFile, "");
    await utimes(expiredDirectory, new Date(0), new Date(0));
    const rmMock = vi.mocked(rm);
    rmMock.mockImplementation(async (target, options) => {
      if (String(target) === expiredDirectory) {
        await actualFs.rm(removableFile, { force: true });
        throw Object.assign(new Error("cleanup busy"), { code: "EBUSY" });
      }
      return actualFs.rm(target, options);
    });
    try {
      await ensureTerminalUploadCleanup({ tempRoot: root });

      await expect(
        stageTerminalUpload({ name: "too-early.bin", contentBase64: "AA==" }, { tempRoot: root }),
      ).rejects.toThrow();
      await expect(stat(removableFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(expiredDirectory)).mtimeMs).toBeGreaterThan(0);
      expect((await stat(expiredFile)).size).toBe(storageLimitBytes / directoryLimit);
      expect(await retainedDirectories(root)).toHaveLength(directoryLimit);

      rmMock.mockImplementation(actualFs.rm);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      await vi.waitFor(async () => {
        await expect(stat(expiredDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      });
      const accepted = await stageTerminalUpload(
        { name: "after-cleanup.bin", contentBase64: "AA==" },
        { tempRoot: root },
      );
      expect(await readFile(accepted.path)).toEqual(Buffer.from([0]));
      expect(await retainedDirectories(root)).toHaveLength(directoryLimit);
    } finally {
      rmMock.mockImplementation(actualFs.rm);
      vi.useRealTimers();
    }
  });

  it("does not treat an uninspectable retained file as free capacity", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-inspection-test-");
    const files = await createRetainedUploads(
      root,
      Array.from(
        { length: storageLimitBytes / MAX_TERMINAL_UPLOAD_BYTES },
        () => MAX_TERMINAL_UPLOAD_BYTES,
      ),
    );
    const lstatMock = vi.mocked(lstat);
    let inspectionFailed = false;
    lstatMock.mockImplementation(async (target, options) => {
      if (String(target) === files[0]) {
        inspectionFailed = true;
        throw Object.assign(new Error("cannot inspect retained upload"), { code: "EACCES" });
      }
      return actualFs.lstat(target, options);
    });
    try {
      await expect(
        stageTerminalUpload({ name: "unaccounted.bin", contentBase64: "AA==" }, { tempRoot: root }),
      ).rejects.toThrow();
      expect(inspectionFailed).toBe(true);
      expect(await retainedDirectories(root)).toHaveLength(files.length);
    } finally {
      lstatMock.mockImplementation(actualFs.lstat);
    }

    await expect(
      stageTerminalUpload({ name: "full.bin", contentBase64: "AA==" }, { tempRoot: root }),
    ).rejects.toThrow();
  });

  it("bounds cleanup timers for over-budget recovery and repeated external deletion", async () => {
    vi.useFakeTimers();
    const root = tempDirs.make("openclaw-terminal-upload-timer-budget-test-");
    try {
      const files = await createRetainedUploads(
        root,
        Array.from({ length: directoryLimit + 1 }, () => 0),
      );
      await ensureTerminalUploadCleanup({ tempRoot: root });

      expect(await retainedDirectories(root)).toHaveLength(directoryLimit + 1);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
      await expect(
        stageTerminalUpload({ name: "over-budget.bin", contentBase64: "" }, { tempRoot: root }),
      ).rejects.toThrow();
      await Promise.all(
        files.map((file) => rm(path.dirname(file), { recursive: true, force: true })),
      );

      for (let index = 0; index < 3; index += 1) {
        const result = await stageTerminalUpload(
          { name: "replacement.bin", contentBase64: "" },
          { tempRoot: root },
        );
        expect(await readFile(result.path)).toEqual(Buffer.alloc(0));
        expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
        await rm(path.dirname(result.path), { recursive: true, force: true });
      }
    } finally {
      vi.useRealTimers();
    }
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
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, "report.pdf"), "stale");
      await utimes(directory, new Date(0), new Date(0));

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
    let partialFile = "";
    let failedRemoval = false;
    writeMock.mockImplementation(async (target, data, options) => {
      if (typeof target === "string" && path.basename(target) === "partial.bin") {
        partialFile = target;
        await actualFs.writeFile(target, data, options);
        throw writeError;
      }
      return actualFs.writeFile(target, data, options);
    });
    rmMock.mockImplementation(async (target, options) => {
      if (partialFile && String(target) === path.dirname(partialFile) && !failedRemoval) {
        failedRemoval = true;
        throw new Error("cleanup busy");
      }
      return actualFs.rm(target, options);
    });
    try {
      await expect(
        stageTerminalUpload({ name: "partial.bin", contentBase64: "AA==" }, { tempRoot: root }),
      ).rejects.toBe(writeError);
      expect(await readFile(partialFile)).toEqual(Buffer.from([0]));

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      await vi.waitFor(async () => {
        await expect(stat(path.dirname(partialFile))).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      writeMock.mockImplementation(actualFs.writeFile);
      rmMock.mockImplementation(actualFs.rm);
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
});
