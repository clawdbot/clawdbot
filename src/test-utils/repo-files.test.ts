import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "./temp-dir.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import { listGitTrackedFiles } from "./repo-files.js";

describe("listGitTrackedFiles", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("bounds Git inventory lookup and returns sorted existing files", async () => {
    await withTempDir("openclaw-repo-files-", async (repoRoot) => {
      await fs.writeFile(path.join(repoRoot, "z.ts"), "");
      await fs.writeFile(path.join(repoRoot, "a.ts"), "");
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: "z.ts\nmissing.ts\na.ts\n",
      });

      expect(listGitTrackedFiles({ repoRoot, pathspecs: "src" })).toEqual(["a.ts", "z.ts"]);
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "git",
        ["ls-files", "--", "src"],
        expect.objectContaining({
          cwd: repoRoot,
          killSignal: "SIGKILL",
          timeout: 5_000,
        }),
      );
    });
  });

  it("caches a timed-out inventory lookup as unavailable", async () => {
    await withTempDir("openclaw-repo-files-timeout-", async (repoRoot) => {
      spawnSyncMock.mockReturnValue({
        error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
        signal: "SIGKILL",
        status: null,
        stdout: "",
      });
      const params = { repoRoot, pathspecs: ["src", "extensions"] };

      expect(listGitTrackedFiles(params)).toBeNull();
      expect(listGitTrackedFiles(params)).toBeNull();
      expect(spawnSyncMock).toHaveBeenCalledOnce();
    });
  });
});
