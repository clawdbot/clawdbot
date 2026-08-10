import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { checkUpdateStatus } from "./update-check.js";

describe("checkUpdateStatus global install detection", () => {
  it("recognizes markerless packages under the active global npm root", async () => {
    await withTempDir({ prefix: "openclaw-update-check-npm-prefix-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      await withEnvAsync({ NPM_CONFIG_PREFIX: prefix }, async () => {
        const npmRootResult = await runCommandWithTimeout(["npm", "root", "-g"], {
          timeoutMs: 5000,
        });
        expect(npmRootResult.code).toBe(0);
        const npmRoot = npmRootResult.stdout.trim();
        const root = path.join(npmRoot, "openclaw");
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw" }),
          "utf8",
        );

        const status = await checkUpdateStatus({
          root,
          includeRegistry: false,
          fetchGit: false,
          timeoutMs: 5000,
        });

        expect(status).toMatchObject({
          installKind: "package",
          packageManager: "npm",
          deps: {
            manager: "npm",
            status: "unknown",
            reason: "lockfile missing",
          },
        });
      });
    });
  });

  it("keeps markerless roots outside npm's global prefix unknown", async () => {
    await withTempDir({ prefix: "openclaw-update-check-npm-mismatch-" }, async (base) => {
      const root = path.join(base, "package-root");
      await fs.mkdir(root);
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "yarn@4.9.2" }),
        "utf8",
      );

      const status = await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 5000,
      });

      expect(status.installKind).toBe("package");
      expect(status.packageManager).toBe("unknown");
      expect(status.deps).toMatchObject({ manager: "unknown", status: "unknown" });
    });
  });

  it("keeps markerless Git roots classified as Git inside an npm prefix", async () => {
    await withTempDir({ prefix: "openclaw-update-check-git-npm-prefix-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      await withEnvAsync({ NPM_CONFIG_PREFIX: prefix }, async () => {
        const npmRootResult = await runCommandWithTimeout(["npm", "root", "-g"], {
          timeoutMs: 5000,
        });
        expect(npmRootResult.code).toBe(0);
        const root = path.join(npmRootResult.stdout.trim(), "openclaw");
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw" }),
          "utf8",
        );
        const gitInit = await runCommandWithTimeout(["git", "init", "--initial-branch=main"], {
          cwd: root,
          timeoutMs: 5000,
        });
        expect(gitInit.code).toBe(0);

        const status = await checkUpdateStatus({
          root,
          includeRegistry: false,
          fetchGit: false,
          timeoutMs: 5000,
        });

        expect(status.installKind).toBe("git");
        expect(status.packageManager).toBe("unknown");
      });
    });
  });
});
