// Vitest extension acpx config wires the extension acpx test shard.
import { acpxExtensionTestRoots } from "./vitest.extension-acpx-paths.mjs";
import { createExtensionVitestConfig } from "./vitest.extension-config.ts";

export function createExtensionAcpxVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("acpx", acpxExtensionTestRoots, env);
}

export default createExtensionAcpxVitestConfig();
