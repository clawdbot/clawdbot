import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RUNTIME_POSTBUILD_STAMP_FILE } from "../../scripts/lib/local-build-metadata-paths.mjs";
import { writeRuntimePostBuildStamp } from "../../scripts/runtime-postbuild-stamp.mjs";

describe("runtime-postbuild-stamp script", () => {
  it("writes dist/.runtime-postbuildstamp with the current git head", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-postbuild-stamp-"));
    try {
      const stampPath = writeRuntimePostBuildStamp({
        cwd: rootDir,
        now: () => 123,
        spawnSync: () => ({ status: 0, stdout: "abc123\n" }),
      });

      expect(path.relative(rootDir, stampPath)).toBe(
        path.join("dist", RUNTIME_POSTBUILD_STAMP_FILE),
      );
      expect(JSON.parse(fs.readFileSync(stampPath, "utf8"))).toEqual({
        syncedAt: 123,
        head: "abc123",
      });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
