import fs from "node:fs/promises";
import path from "node:path";
import { createNpmTarget, writePackageRoot } from "./package-update-steps.test-support.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";

export async function createPackageSwapFixture(base: string) {
  const prefix = path.join(base, "live");
  const globalRoot = path.join(prefix, "lib", "node_modules");
  const packageRoot = path.join(globalRoot, "openclaw");
  const stagePrefix = path.join(base, "stage");
  const stageGlobalRoot = path.join(stagePrefix, "lib", "node_modules");
  const stagePackageRoot = path.join(stageGlobalRoot, "openclaw");
  await writePackageRoot(packageRoot, "1.0.0");
  await writePackageRoot(stagePackageRoot, "2.0.0");
  const launcher = path.join(prefix, "bin", "openclaw");
  const stagedLauncher = path.join(stagePrefix, "bin", "openclaw");
  for (const entry of [launcher, stagedLauncher]) {
    await fs.mkdir(path.dirname(entry), { recursive: true });
  }
  await fs.writeFile(launcher, "old launcher\n");
  await fs.writeFile(stagedLauncher, "candidate launcher\n");
  const params = {
    installTarget: createNpmTarget(globalRoot),
    packageName: "openclaw",
    stage: {
      prefix: stagePrefix,
      layout: {
        prefix: stagePrefix,
        globalRoot: stageGlobalRoot,
        binDir: path.dirname(stagedLauncher),
      },
      packageRoot: stagePackageRoot,
      installTarget: createNpmTarget(stageGlobalRoot),
    },
  };
  return { params, packageRoot, globalRoot, launcher };
}

export async function createRetainedPackageSwap(base: string) {
  const fixture = await createPackageSwapFixture(base);
  let transaction: PackageUpdateTransaction | undefined;
  const result = await swapStagedPackageInstall({
    ...fixture.params,
    onTransaction: (retained) => {
      transaction = retained;
    },
  });
  if (!transaction || result.status !== "committed") {
    throw new Error(`Retained swap fixture failed: ${result.step.stderrTail}`);
  }
  return { ...fixture, result, transaction };
}
