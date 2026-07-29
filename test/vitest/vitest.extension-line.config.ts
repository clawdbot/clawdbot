// Vitest extension line config wires the extension line test shard.
import { createSingleChannelExtensionVitestConfig } from "./vitest.extension-channel-single-config.ts";

export function createExtensionLineVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createSingleChannelExtensionVitestConfig("line", env);
}

export default createExtensionLineVitestConfig();
