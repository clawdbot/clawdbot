import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLowDiskSpaceWarning, formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";

function statfsFixture(params: {
  bavail: number;
  bsize?: number;
  blocks?: number;
}): ReturnType<typeof fs.statfsSync> {
  return {
    type: 0,
    bsize: params.bsize ?? 1024,
    blocks: params.blocks ?? 2_000_000,
    bfree: params.bavail,
    bavail: params.bavail,
    files: 0,
    ffree: 0,
  };
}

describe("disk-space helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads disk space from the nearest existing ancestor", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-disk-space-"));
    try {
      const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue(
        statfsFixture({
          bavail: 512,
          bsize: 1024,
          blocks: 4096,
        }),
      );

      const snapshot = tryReadDiskSpace(path.join(tempDir, "missing", "child"));

      expect(snapshot).toEqual({
        targetPath: path.join(tempDir, "missing", "child"),
        checkedPath: tempDir,
        availableBytes: 512 * 1024,
        totalBytes: 4096 * 1024,
      });
      expect(statfs).toHaveBeenCalledWith(tempDir);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("formats low disk warnings without making them hard errors", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-disk-space-"));
    try {
      vi.spyOn(fs, "statfsSync").mockReturnValue(
        statfsFixture({
          bavail: 256,
          bsize: 1024 * 1024,
        }),
      );

      expect(
        createLowDiskSpaceWarning({
          targetPath: tempDir,
          purpose: "test staging",
          thresholdBytes: 512 * 1024 * 1024,
        }),
      ).toBe(`Low disk space near ${tempDir}: 256 MiB available; test staging may fail.`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps byte formatting compact", () => {
    expect(formatDiskSpaceBytes(420 * 1024 * 1024)).toBe("420 MiB");
    expect(formatDiskSpaceBytes(1536 * 1024 * 1024)).toBe("1.5 GiB");
  });
});
