import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension messaging config wires the extension messaging test shard.
import { messagingExtensionTestRoots } from "./vitest.extension-messaging-paths.mjs";

export function createExtensionMessagingVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("messaging", messagingExtensionTestRoots, env);
}

export default createExtensionMessagingVitestConfig();
