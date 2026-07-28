// Tests safe boundary file reads against upstream fs-safe behavior.
import fs from "node:fs";
import path from "node:path";
import * as upstream from "@openclaw/fs-safe/advanced";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as shim from "./boundary-file-read.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("root file open shim", () => {
  it("re-exports the fs-safe root file helpers", () => {
    expect(shim.canUseRootFileOpen).toBe(upstream.canUseRootFileOpen);
    expect(shim.matchRootFileOpenFailure).toBe(upstream.matchRootFileOpenFailure);
    expect(shim.openRootFile).toBe(upstream.openRootFile);
    expect(shim.openRootFileSync).toBe(upstream.openRootFileSync);
  });

  it("preserves the existing overflow error for fs-safe descriptor reads", async () => {
    const dir = tempDirs.make("openclaw-boundary-file-read-");
    const filePath = path.join(dir, "oversized.txt");
    fs.writeFileSync(filePath, "oversized");

    const asyncFd = fs.openSync(filePath, "r");
    try {
      await expect(shim.readFileDescriptorBounded(asyncFd, 4)).rejects.toThrow(
        new RangeError("File exceeds 4 bytes"),
      );
    } finally {
      fs.closeSync(asyncFd);
    }

    const syncFd = fs.openSync(filePath, "r");
    try {
      expect(() => shim.readFileDescriptorBoundedSync(syncFd, 4)).toThrow(
        new RangeError("File exceeds 4 bytes"),
      );
    } finally {
      fs.closeSync(syncFd);
    }
  });
});
