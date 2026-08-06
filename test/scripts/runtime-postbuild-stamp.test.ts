// Runtime Postbuild Stamp tests cover runtime postbuild stamp script behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_POSTBUILD_STAMP_FILE } from "../../scripts/lib/local-build-metadata-paths.mjs";
import { writeRuntimePostBuildStamp } from "../../scripts/runtime-postbuild-stamp.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

describe("runtime-postbuild-stamp script", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("writes dist/.runtime-postbuildstamp with the current git head", () => {
    const rootDir = tempDirs.make("openclaw-runtime-postbuild-stamp-");
    const stampPath = writeRuntimePostBuildStamp({
      cwd: rootDir,
      now: () => 123,
      spawnSync: () => ({ status: 0, stdout: "abc123\n" }),
    });

    expect(path.relative(rootDir, stampPath)).toBe(path.join("dist", RUNTIME_POSTBUILD_STAMP_FILE));
    expect(JSON.parse(fs.readFileSync(stampPath, "utf8"))).toEqual({
      syncedAt: 123,
      head: "abc123",
    });
  });
});
