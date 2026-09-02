// Vitest extension msteams config wires the extension msteams test shard.
import { msTeamsExtensionTestRoots } from "./vitest.extension-msteams-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionMsTeamsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    msTeamsExtensionTestRoots.map((root) => `${root}/**/*.test.ts`),
    {
      dir: "extensions",
      env,
      name: "extension-msteams",
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
    },
  );
}

export default createExtensionMsTeamsVitestConfig();
