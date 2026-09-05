// Vitest extension config helpers keep extension shard defaults aligned.
import type { ViteUserConfig } from "vitest/config";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { pluginControlUiPathGlob } from "./vitest.ui-paths.mjs";

type ExtensionVitestConfigOptions = {
  fileParallelism?: boolean;
  includeOpenClawRuntimeSetup?: boolean;
  isolate?: boolean;
};

export function createExtensionVitestConfig(
  name: string,
  testRoots: readonly string[],
  env: Record<string, string | undefined> = process.env,
  options: ExtensionVitestConfigOptions = {},
): ViteUserConfig {
  return createScopedVitestConfig(
    testRoots.map((root) => `${root}/**/*.test.ts`),
    {
      dir: "extensions",
      env,
      name: `extension-${name}`,
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
      exclude: [pluginControlUiPathGlob],
      ...options,
    },
  );
}

export function createSingleChannelExtensionVitestConfig(
  extensionId: string,
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig([`extensions/${extensionId}/**/*.test.ts`], {
    dir: "extensions",
    env,
    name: `extension-${extensionId}`,
    passWithNoTests: true,
    setupFiles: ["test/setup.extensions.ts"],
    exclude: [pluginControlUiPathGlob],
  });
}
