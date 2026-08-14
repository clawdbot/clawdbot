import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension mattermost config wires the extension mattermost test shard.
import { mattermostExtensionTestRoots } from "./vitest.extension-mattermost-paths.mjs";

export function createExtensionMattermostVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("mattermost", mattermostExtensionTestRoots, env);
}

export default createExtensionMattermostVitestConfig();
