// Vitest extension imessage config wires the extension imessage test shard.
import { createSingleChannelExtensionVitestConfig } from "./vitest.extension-channel-single-config.ts";

export function createExtensionImessageVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createSingleChannelExtensionVitestConfig("imessage", env);
}

export default createExtensionImessageVitestConfig();
