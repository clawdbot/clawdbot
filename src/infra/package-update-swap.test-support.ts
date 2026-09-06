import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "./package-dist-inventory.js";
import { createNpmTarget, writePackageRoot } from "./package-update-steps.test-support.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";

export async function createRetainedPackageSwap(base: string, failBackupCleanup = false) {
  const prefix = path.join(base, "live");
  const globalRoot = path.join(prefix, "lib", "node_modules");
  const installTarget = createNpmTarget(globalRoot);
  const packageRoot = path.join(globalRoot, "openclaw");
  const stagePrefix = path.join(base, "stage");
  const stageGlobalRoot = path.join(stagePrefix, "lib", "node_modules");
  const stagePackageRoot = path.join(stageGlobalRoot, "openclaw");
  await writePackageRoot(packageRoot, "1.0.0");
  await writePackageRoot(stagePackageRoot, "2.0.0");
  let transaction: PackageUpdateTransaction | undefined;
  let copied = false;
  let cleanupRejected = false;
  const rename = fs.rename.bind(fs);
  const unlink = fs.unlink.bind(fs);
  const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
    if (failBackupCleanup && String(args[0]) === packageRoot && !copied) {
      copied = true;
      throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
    }
    return rename(...args);
  });
  const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
    if (failBackupCleanup && String(target) === path.join(packageRoot, "dist", "index.js")) {
      await fs.rm(path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH), { force: true });
      await unlink(target);
      cleanupRejected = true;
      throw Object.assign(new Error("source cleanup failed after commit"), { code: "EACCES" });
    }
    return unlink(target);
  });
  try {
    const result = await swapStagedPackageInstall({
      installTarget,
      packageName: "openclaw",
      stage: {
        prefix: stagePrefix,
        layout: {
          prefix: stagePrefix,
          globalRoot: stageGlobalRoot,
          binDir: path.join(stagePrefix, "bin"),
        },
        packageRoot: stagePackageRoot,
        installTarget: createNpmTarget(stageGlobalRoot),
      },
      onTransaction: (retained) => {
        transaction = retained;
      },
    });
    if (!transaction || (failBackupCleanup && !cleanupRejected)) {
      throw new Error("Retained swap fixture did not reach its requested outcome");
    }
    return { result, transaction, packageRoot };
  } finally {
    renameSpy.mockRestore();
    unlinkSpy.mockRestore();
  }
}
