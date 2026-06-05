// Vitest extension active memory config wires the extension active memory test shard.
import { activeMemoryExtensionTestRoots } from "./vitest.extension-active-memory-paths.mjs";
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function loadIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createExtensionActiveMemoryVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(
    loadIncludePatternsFromEnv(env) ??
      activeMemoryExtensionTestRoots.map((root) => `${root}/**/*.test.ts`),
    {
      dir: "extensions",
      env,
      name: "extension-active-memory",
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
    },
  );
}

export default createExtensionActiveMemoryVitestConfig();
