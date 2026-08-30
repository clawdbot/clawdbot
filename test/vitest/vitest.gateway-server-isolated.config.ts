// Vitest gateway isolated config wires module-mocking Gateway tests out of the
// shared module cache.
import { defineConfig } from "vitest/config";
import { gatewayServerIsolatedTestFiles } from "./vitest.gateway-server-paths.mjs";
import {
  intersectIncludePatterns,
  loadPatternListFromEnv,
  narrowIncludePatternsForCli,
} from "./vitest.pattern-file.ts";
import { resolveRepoRootPath, sharedVitestConfig } from "./vitest.shared.config.ts";

export function createGatewayServerIsolatedVitestConfig(
  env: Record<string, string | undefined> = process.env,
  options: { argv?: string[] } = {},
) {
  const sharedTest = sharedVitestConfig.test ?? {};
  const includeFromEnv = intersectIncludePatterns(
    gatewayServerIsolatedTestFiles,
    loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env),
  );
  const cliInclude = narrowIncludePatternsForCli(gatewayServerIsolatedTestFiles, options.argv);

  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...sharedTest,
      name: "gateway-server-isolated",
      // These files replace a module the Gateway reaches through re-exports, so a
      // neighbour that already bound the real implementation would defeat the mock.
      isolate: true,
      runner: undefined,
      setupFiles: [resolveRepoRootPath("test/setup.env.ts")],
      include: includeFromEnv ?? cliInclude ?? gatewayServerIsolatedTestFiles,
      exclude: sharedTest.exclude ?? [],
      passWithNoTests: true,
    },
  });
}

export default createGatewayServerIsolatedVitestConfig();
