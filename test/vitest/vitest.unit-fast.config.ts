// Vitest unit fast config wires the unit fast test shard.
import { defineConfig } from "vitest/config";
import {
  intersectIncludePatterns,
  loadPatternListFromEnv,
  narrowIncludePatternsForCli,
} from "./vitest.pattern-file.ts";
import { resolveRepoRootPath, sharedVitestConfig } from "./vitest.shared.config.ts";
import {
  getUnitFastIsolatedTestFiles,
  getUnitFastTestFiles,
  getUnitFastTimerTestFiles,
} from "./vitest.unit-fast-paths.mjs";

export function createUnitFastVitestConfig(
  env: Record<string, string | undefined> = process.env,
  options: { argv?: string[]; runner?: string } = {},
) {
  const sharedTest = sharedVitestConfig.test ?? {};
  const timerTestFiles = new Set(getUnitFastTimerTestFiles());
  const isolatedTestFiles = new Set(getUnitFastIsolatedTestFiles());
  const unitFastTestFiles = getUnitFastTestFiles().filter(
    (file) => !timerTestFiles.has(file) && !isolatedTestFiles.has(file),
  );
  const includeFromEnv = intersectIncludePatterns(
    unitFastTestFiles,
    loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env),
  );
  const cliInclude = narrowIncludePatternsForCli(unitFastTestFiles, options.argv);

  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...sharedTest,
      name: "unit-fast",
      isolate: false,
      runner: options.runner,
      // Env isolation only (no shared-setup mocks): membership is auto-curated,
      // so tests must never read the developer's real config/state.
      setupFiles: [resolveRepoRootPath("test/setup.env.ts")],
      include: includeFromEnv ?? cliInclude ?? unitFastTestFiles,
      exclude: sharedTest.exclude ?? [],
      passWithNoTests: true,
    },
  });
}

export default createUnitFastVitestConfig();
