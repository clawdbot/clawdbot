import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension irc config wires the extension irc test shard.
import { ircExtensionTestRoots } from "./vitest.extension-irc-paths.mjs";

export function createExtensionIrcVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("irc", ircExtensionTestRoots, env);
}

export default createExtensionIrcVitestConfig();
