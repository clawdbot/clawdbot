import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionSlackVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(["extensions/slack/**/*.test.ts"], {
    dir: "extensions",
    env,
    includeOpenClawRuntimeSetup: false,
    name: "extension-slack",
    passWithNoTests: true,
    setupFiles: ["test/setup.extensions.ts"],
  });
}

export default createExtensionSlackVitestConfig();
