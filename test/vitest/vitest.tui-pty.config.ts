// Vitest tui pty config wires the tui pty test shard.
import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { resolveRepoRootPath, sharedVitestConfig } from "./vitest.shared.config.ts";
import { tuiPtyTestFiles } from "./vitest.test-shards.mjs";

const targetableIncludes = [
  "src/tui/tui-pty-harness-assertion-test-support.test.ts",
  ...tuiPtyTestFiles,
].flatMap((target) => [target, target.replace(/^src\//u, "")]);

function toTuiPtyIncludePatterns(patterns: string[] | null) {
  return patterns?.map((pattern) => pattern.replace(/^src\//u, "")) ?? null;
}

export function createTuiPtyVitestConfig(env?: Record<string, string | undefined>) {
  const baseTest = sharedVitestConfig.test ?? {};
  const exclude = (baseTest.exclude ?? []).filter((pattern) => pattern !== "**/*.e2e.test.ts");
  const configEnv = env ?? process.env;
  const includeLocal = configEnv.OPENCLAW_TUI_PTY_INCLUDE_LOCAL === "1";
  const include = tuiPtyTestFiles
    .filter((target) => includeLocal || !target.endsWith("tui-pty-local.e2e.test.ts"))
    .map((target) => target.replace(/^src\//u, ""));
  const includeFromEnv = toTuiPtyIncludePatterns(
    loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", configEnv),
  );
  const includeFromArgv = toTuiPtyIncludePatterns(narrowIncludePatternsForCli(targetableIncludes));
  const baseSequence = (baseTest as { sequence?: { groupOrder?: number } }).sequence;

  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...baseTest,
      env,
      name: "tui-pty",
      dir: resolveRepoRootPath("src"),
      include: includeFromEnv ?? includeFromArgv ?? include,
      exclude,
      fileParallelism: false,
      maxWorkers: 1,
      reporters: ["verbose", ...(configEnv.GITHUB_ACTIONS === "true" ? ["github-actions"] : [])],
      setupFiles: [
        ...new Set(
          [...(baseTest.setupFiles ?? []), "test/setup-openclaw-runtime.ts"].map(
            resolveRepoRootPath,
          ),
        ),
      ],
      sequence: {
        ...baseSequence,
        groupOrder: 95,
      },
    },
  });
}

export default createTuiPtyVitestConfig();
