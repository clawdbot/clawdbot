import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearExecutablePathCache } from "../infra/executable-path.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { assertGitHubCliAvailable } from "./github-cli-preflight.js";

afterEach(() => {
  clearExecutablePathCache();
});

describe("GitHub CLI preflight", () => {
  it("recognizes an installation immediately after a missing-CLI retry", async () => {
    await withTestDir({ prefix: "openclaw-github-cli-" }, async (binDir) => {
      const executableName = process.platform === "win32" ? "gh.cmd" : "gh";
      const executablePath = path.join(binDir, executableName);
      const env = {
        PATH: binDir,
        ...(process.platform === "win32" ? { PATHEXT: ".CMD" } : {}),
      };

      expect(() => assertGitHubCliAvailable(env)).toThrow("GitHub CLI (`gh`) is required");
      await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      expect(() => assertGitHubCliAvailable(env)).not.toThrow();
      await fs.rm(executablePath);
      expect(() => assertGitHubCliAvailable(env)).toThrow("GitHub CLI (`gh`) is required");
    });
  });
});
