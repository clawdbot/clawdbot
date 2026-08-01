import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn());

vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tmp-openclaw-dir.js")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
  };
});

import { withTempDir } from "./install-source-utils.js";

describe("withTempDir private root", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.runIf(process.platform !== "win32")(
    "preserves parent temp root permissions when using private OpenClaw temp root",
    async () => {
      const mockParentRoot = tempDirs.make("openclaw-chmod-test-");
      const mockOpenClawDir = path.join(mockParentRoot, "openclaw");

      await fs.mkdir(mockOpenClawDir, { recursive: true });
      await fs.chmod(mockParentRoot, 0o1777);
      const canonicalOpenClawDir = await fs.realpath(mockOpenClawDir);

      resolvePreferredOpenClawTmpDirMock.mockReturnValue(mockOpenClawDir);

      let observedDir = "";
      const value = await withTempDir("openclaw-test-", async (tmpDir) => {
        observedDir = tmpDir;
        expect(path.dirname(tmpDir)).toBe(canonicalOpenClawDir);
        await fs.writeFile(path.join(tmpDir, "marker.txt"), "ok");
        return "done";
      });

      expect(value).toBe("done");

      await expect(
        fs.stat(observedDir).then(
          () => true,
          () => false,
        ),
      ).resolves.toBe(false);

      const privateRootStat = await fs.stat(mockOpenClawDir);
      expect(privateRootStat.mode & 0o7777).toBe(0o700);

      const parentStat = await fs.stat(mockParentRoot);
      expect(parentStat.mode & 0o7777).toBe(0o1777);
    },
  );
});
