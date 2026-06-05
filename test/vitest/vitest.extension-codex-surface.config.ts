// Vitest extension codex surface config wires the extension codex surface test shard.
import { codexExtensionTestRoots } from "./vitest.extension-codex-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionCodexSurfaceVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(
    codexExtensionTestRoots.map((root) => `${root}/**/*.test.ts`),
    {
      dir: "extensions",
      env,
      exclude: ["extensions/codex/src/app-server/**/*.test.ts"],
      fileParallelism: false,
      name: "extension-codex-surface",
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
    },
  );
}

export default createExtensionCodexSurfaceVitestConfig();
