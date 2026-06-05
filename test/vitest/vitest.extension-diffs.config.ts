// Vitest extension diffs config wires the extension diffs test shard.
import { diffsExtensionTestRoots } from "./vitest.extension-diffs-paths.mjs";
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function loadIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createExtensionDiffsVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(
    loadIncludePatternsFromEnv(env) ??
      diffsExtensionTestRoots.map((root) => `${root}/**/*.test.ts`),
    {
      dir: "extensions",
      env,
      name: "extension-diffs",
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
    },
  );
}

export default createExtensionDiffsVitestConfig();
