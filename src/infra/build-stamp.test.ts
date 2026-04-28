import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { writeBuildStamp } from "../../scripts/build-stamp.mjs";
import { BUILD_STAMP_FILE } from "../../scripts/lib/local-build-metadata-paths.mjs";
import { withTempDir } from "../test-helpers/temp-dir.js";

describe("build-stamp script", () => {
  it("writes dist/.buildstamp with the current git head", async () => {
    await withTempDir({ prefix: "openclaw-build-stamp-" }, async (tmp) => {
      const stampPath = writeBuildStamp({
        cwd: tmp,
        now: () => 1_700_000_000_000,
        spawnSync: (cmd: string, args: string[]) => {
          if (cmd === "git" && args[0] === "rev-parse") {
            return { status: 0, stdout: "abc123\n" };
          }
          return { status: 1, stdout: "" };
        },
      });
      expect(stampPath.endsWith(`/dist/${BUILD_STAMP_FILE}`)).toBe(true);

      await expect(fs.readFile(stampPath, "utf8")).resolves.toBe(
        '{"builtAt":1700000000000,"head":"abc123"}\n',
      );
    });
  });
});
