import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeArchiveStreamToFile } from "./backup-create-stream.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("writeArchiveStreamToFile", () => {
  it("closes a partial archive before propagating a stream error", async () => {
    const tempDir = tempDirs.make("openclaw-backup-stream-");
    const archivePath = path.join(tempDir, "partial.tar.gz");
    const archiveStream = new PassThrough();
    const writePromise = writeArchiveStreamToFile({
      archivePath,
      archiveStream,
    });
    archiveStream.write("partial archive");
    archiveStream.destroy(new Error("injected tar read failure"));

    await expect(writePromise).rejects.toThrow("injected tar read failure");
    await expect(fs.rm(archivePath)).resolves.toBeUndefined();
  });
});
