// Vitest ui e2e config wires the ui e2e test shard.
import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { sharedVitestConfig } from "./vitest.shared.config.ts";

const uiE2eIncludePatterns = ["ui/src/**/*.e2e.test.ts"];

export function createUiE2eVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  const base = sharedVitestConfig as Record<string, unknown>;
  const baseTest = sharedVitestConfig.test ?? {};
  const exclude = (baseTest.exclude ?? []).filter((pattern) => pattern !== "**/*.e2e.test.ts");
  const includeFromEnv = loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
  const include =
    includeFromEnv ??
    narrowIncludePatternsForCli(uiE2eIncludePatterns, argv) ??
    uiE2eIncludePatterns;

  return defineConfig({
    ...base,
    cacheDir: ".artifacts/vite-ui-e2e",
    test: {
      ...baseTest,
      environment: "node",
      exclude,
      fileParallelism: false,
      include,
      isolate: true,
      name: "ui-e2e",
      pool: "forks",
      runner: undefined,
      setupFiles: [],
    },
  });
}

export default createUiE2eVitestConfig();
