import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TERMINAL_UPLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/terminal-constants.js";
import { isCanonicalTerminalUploadBase64 } from "../../packages/gateway-protocol/src/schema/terminal-constants.js";
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
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, "report.pdf"), "stale");
    await utimes(directory, new Date(0), new Date(0));

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
});
