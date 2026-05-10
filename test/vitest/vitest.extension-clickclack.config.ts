import { createSingleChannelExtensionVitestConfig } from "./vitest.extension-channel-single-config.ts";

export function createExtensionClickClackVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createSingleChannelExtensionVitestConfig("clickclack", env);
}

export default createExtensionClickClackVitestConfig();
