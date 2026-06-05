// Vitest extension irc config wires the extension irc test shard.
import { ircExtensionTestRoots } from "./vitest.extension-irc-paths.mjs";
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function loadIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createExtensionIrcVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(
    loadIncludePatternsFromEnv(env) ?? ircExtensionTestRoots.map((root) => `${root}/**/*.test.ts`),
    {
      dir: "extensions",
      env,
      name: "extension-irc",
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
    },
  );
}

export default createExtensionIrcVitestConfig();
