import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import path from "node:path";

export function copyDockerSchedulerHarness(root: string) {
  const scriptsDir = path.join(root, "scripts");
  const libDir = path.join(scriptsDir, "lib");
  const upgradeSurvivorDir = path.join(scriptsDir, "e2e/lib/upgrade-survivor");
  mkdirSync(libDir, { recursive: true });
  mkdirSync(upgradeSurvivorDir, { recursive: true });
  copyFileSync("package.json", path.join(root, "package.json"));
  copyFileSync("scripts/test-docker-all.mjs", path.join(scriptsDir, "test-docker-all.mjs"));
  copyFileSync("scripts/test-docker-all.mts", path.join(scriptsDir, "test-docker-all.mts"));
  copyFileSync("scripts/lib/tsx-cli-shim.mjs", path.join(libDir, "tsx-cli-shim.mjs"));
  copyFileSync("scripts/tsx.mjs", path.join(scriptsDir, "tsx.mjs"));
  copyFileSync(
    "scripts/prepublish-plugin-registry-artifact.mjs",
    path.join(scriptsDir, "prepublish-plugin-registry-artifact.mjs"),
  );
  copyFileSync("scripts/windows-cmd-helpers.mjs", path.join(scriptsDir, "windows-cmd-helpers.mjs"));
  for (const fileName of [
    "docker-e2e-plan.mts",
    "docker-e2e-scenarios.mts",
    "local-check-runtime.mts",
    "managed-child-process.mts",
    "official-external-channel-catalog.json",
    "release-version.mjs",
    "sleep.mjs",
    "windows-taskkill.mjs",
  ]) {
    copyFileSync(path.join("scripts/lib", fileName), path.join(libDir, fileName));
  }
  copyFileSync(
    "scripts/e2e/lib/upgrade-survivor/config-recipe.mts",
    path.join(upgradeSurvivorDir, "config-recipe.mts"),
  );
  cpSync(
    "scripts/e2e/lib/upgrade-survivor/config-recipe",
    path.join(upgradeSurvivorDir, "config-recipe"),
    { recursive: true },
  );
  return scriptsDir;
}
