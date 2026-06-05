// Vitest extension channels config wires the extension channels test shard.
import {
  extensionChannelOverrideExcludeGlobs,
  extensionChannelTestInclude,
} from "./vitest.channel-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionChannelsVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(extensionChannelTestInclude, {
    dir: "extensions",
    env,
    exclude: extensionChannelOverrideExcludeGlobs,
    name: "extension-channels",
    passWithNoTests: true,
  });
}

export default createExtensionChannelsVitestConfig();
