import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as processExec from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveUpdateInstallKind } from "./update-check.js";

async function initGit(...args: string[]): Promise<void> {
  const result = await processExec.runCommandWithTimeout(["git", "init", ...args], {
    timeoutMs: 5000,
  });
  expect(result.code, result.stderr).toBe(0);
}

afterEach(() => vi.restoreAllMocks());

describe("resolveUpdateInstallKind", () => {
  it("classifies exact Git ownership with one subprocess per root", async () => {
    await withTestDir({ prefix: "openclaw-update-install-kind-" }, async (base) => {
      const root = path.join(base, "repo");
      const alias = path.join(base, "alias");
      const nested = path.join(root, "node_modules", "openclaw");
      await initGit("--separate-git-dir", path.join(base, "git-dir"), root);
      await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
      await fs.mkdir(nested, { recursive: true });
      const runCommand = vi.spyOn(processExec, "runCommandWithTimeout");

      await expect(resolveUpdateInstallKind(root)).resolves.toBe("git");
      await expect(resolveUpdateInstallKind(alias)).resolves.toBe("git");
      await expect(resolveUpdateInstallKind(nested)).resolves.toBe("package");

      expect(runCommand).toHaveBeenCalledTimes(3);
    });
  });

  it.each(["absent", "invalid-file", "invalid-directory"])(
    "does not treat a %s Git marker as a checkout",
    async (marker) => {
      await withTestDir({ prefix: "openclaw-update-install-marker-" }, async (root) => {
        if (marker === "invalid-file") {
          await fs.writeFile(path.join(root, ".git"), "not a Git directory pointer\n");
        } else if (marker === "invalid-directory") {
          await fs.mkdir(path.join(root, ".git"));
        }

        await expect(resolveUpdateInstallKind(root)).resolves.toBe("package");
      });
    },
  );

  it("honors explicit Git directory and work-tree ownership without a marker", async () => {
    await withTestDir({ prefix: "openclaw-update-install-git-env-" }, async (base) => {
      const root = path.join(base, "repo");
      const gitDir = path.join(base, "git-dir");
      await fs.mkdir(root);
      await initGit("--bare", gitDir);

      await withEnvAsync({ GIT_DIR: gitDir, GIT_WORK_TREE: root }, async () => {
        await expect(resolveUpdateInstallKind(root)).resolves.toBe("git");
      });
    });
  });

  it("keeps unavailable and undiscovered roots distinct", async () => {
    await withTestDir({ prefix: "openclaw-update-install-missing-" }, async (base) => {
      await expect(resolveUpdateInstallKind(path.join(base, "missing"))).resolves.toBe("package");
      await expect(resolveUpdateInstallKind(null)).resolves.toBe("unknown");
    });
  });
});
