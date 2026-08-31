import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../scripts/lib/package-lifecycle-marker.mjs";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { completePendingPackageLifecycle } from "./package-lifecycle.js";

describe("package lifecycle completion", () => {
  it("runs preinstall and postinstall once before releasing concurrent callers", async () => {
    await withTestDir({ prefix: "openclaw-package-lifecycle-" }, async (packageRoot) => {
      const markerPath = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
      await fs.writeFile(markerPath, "pending\n");
      const calls: string[] = [];
      let releasePreinstall: (() => void) | undefined;
      const preinstallBlocked = new Promise<void>((resolve) => {
        releasePreinstall = resolve;
      });
      let firstPreinstallStarted: (() => void) | undefined;
      const firstPreinstall = new Promise<void>((resolve) => {
        firstPreinstallStarted = resolve;
      });
      const runScript = vi.fn(async (script: { name: string }) => {
        calls.push(script.name);
        if (script.name === "preinstall") {
          firstPreinstallStarted?.();
          await preinstallBlocked;
        } else {
          await fs.rm(markerPath);
        }
      });

      const first = completePendingPackageLifecycle({ packageRoot, runScript });
      await firstPreinstall;
      const second = completePendingPackageLifecycle({ packageRoot, runScript });
      releasePreinstall?.();

      await expect(Promise.all([first, second])).resolves.toSatisfy(
        (results: boolean[]) => results.filter(Boolean).length === 1,
      );
      expect(calls).toEqual(["preinstall", "postinstall"]);
    });
  });

  it("retains pending state when postinstall fails", async () => {
    await withTestDir({ prefix: "openclaw-package-lifecycle-failure-" }, async (packageRoot) => {
      const markerPath = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
      await fs.writeFile(markerPath, "pending\n");

      await expect(
        completePendingPackageLifecycle({
          packageRoot,
          runScript: (script) => {
            if (script.name === "postinstall") {
              throw new Error("postinstall failed");
            }
          },
        }),
      ).rejects.toThrow("postinstall failed");
      await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("pending\n");
    });
  });

  it.each([
    ["default update", 30 * 60_000],
    ["automatic update", 45 * 60_000],
    ["explicit longer update", 75 * 60_000],
  ])("records the %s lifecycle budget on its lock", async (_name, scriptTimeoutMs) => {
    await withTestDir({ prefix: "openclaw-package-lifecycle-lock-" }, async (packageRoot) => {
      const markerPath = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
      await fs.writeFile(markerPath, "pending\n");
      let releasePreinstall: (() => void) | undefined;
      let preinstallCalls = 0;
      const preinstallBlocked = new Promise<void>((resolve) => {
        releasePreinstall = resolve;
      });
      let firstPreinstallStarted: (() => void) | undefined;
      const firstPreinstall = new Promise<void>((resolve) => {
        firstPreinstallStarted = resolve;
      });
      const runScript = async (script: { name: string }) => {
        if (script.name === "preinstall") {
          preinstallCalls += 1;
          if (preinstallCalls > 1) {
            throw new Error("concurrent lifecycle execution");
          }
          firstPreinstallStarted?.();
          await preinstallBlocked;
        } else {
          await fs.rm(markerPath);
        }
      };

      const startedAt = Date.now();
      const first = completePendingPackageLifecycle({
        packageRoot,
        runScript,
        timeoutMs: scriptTimeoutMs,
      });
      await firstPreinstall;
      const lockStat = await fs.stat(path.join(packageRoot, ".openclaw-lifecycle-lock"));
      expect(lockStat.mtimeMs).toBeGreaterThanOrEqual(startedAt + scriptTimeoutMs * 2 - 1_000);
      const second = completePendingPackageLifecycle({
        packageRoot,
        runScript,
        timeoutMs: scriptTimeoutMs,
      });
      const secondResult = second.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });

      expect(preinstallCalls).toBe(1);
      releasePreinstall?.();
      await expect(first).resolves.toBe(true);
      await expect(secondResult).resolves.toEqual({ value: false });
    });
  });

  it("migrates the shipped dist guard before retrying the complete lifecycle", async () => {
    await withTestDir({ prefix: "openclaw-package-lifecycle-legacy-" }, async (packageRoot) => {
      const markerPath = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
      const legacyGuardPath = path.join(packageRoot, LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH);
      await fs.mkdir(path.dirname(legacyGuardPath), { recursive: true });
      await fs.writeFile(legacyGuardPath, "pending\n");

      await expect(
        completePendingPackageLifecycle({
          packageRoot,
          runScript: async (script) => {
            await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("pending\n");
            if (script.name === "preinstall") {
              await fs.rm(legacyGuardPath);
            } else {
              await fs.rm(markerPath);
            }
          },
        }),
      ).resolves.toBe(true);
    });
  });
});
