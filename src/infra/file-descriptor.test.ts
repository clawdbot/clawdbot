import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { copyFileHandle, hashFileDescriptorSync } from "./file-descriptor.js";

let directory: string;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bytes = Buffer.concat([Buffer.alloc(1024 * 1024, 0x61), Buffer.from("tail")]);
const expectedHash = createHash("sha256").update(bytes).digest("hex");

beforeEach(() => {
  directory = tempDirs.make("openclaw-file-descriptor-");
});

describe("pinned file descriptors", () => {
  it("hashes all bytes without moving or closing the borrowed descriptor", async () => {
    const sourcePath = path.join(directory, "source");
    await fs.writeFile(sourcePath, bytes);
    const fd = openSync(sourcePath, "r");
    try {
      readSync(fd, Buffer.alloc(2));
      expect(hashFileDescriptorSync(fd)).toEqual({
        sha256: expectedHash,
        sizeBytes: bytes.length,
      });
      const remaining = Buffer.alloc(bytes.length);
      const count = readSync(fd, remaining);
      expect(remaining.subarray(0, count)).toEqual(bytes.subarray(2));
    } finally {
      closeSync(fd);
    }
  });

  it("copies and observes all source bytes while retaining both handle positions", async () => {
    const source = await fs.open(path.join(directory, "source"), "wx+");
    const targetPath = path.join(directory, "target");
    const target = await fs.open(targetPath, "wx+");
    try {
      await source.writeFile(bytes);
      await target.writeFile("seed");
      const observed = createHash("sha256");
      expect(
        await copyFileHandle(source, target, {
          noProgressMessage: "copy stalled",
          onChunk: (chunk) => {
            observed.update(chunk);
          },
        }),
      ).toBe(bytes.length);
      expect(observed.digest("hex")).toBe(expectedHash);
      expect(await fs.readFile(targetPath)).toEqual(bytes);
      expect(await source.readFile()).toHaveLength(0);
      expect(await target.readFile()).toEqual(bytes.subarray(4));
    } finally {
      await target.close();
      await source.close();
    }
  });
});
