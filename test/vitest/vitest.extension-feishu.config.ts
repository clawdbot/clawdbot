import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension feishu config wires the extension feishu test shard.
import { feishuExtensionTestRoots } from "./vitest.extension-feishu-paths.mjs";

export function createExtensionFeishuVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("feishu", feishuExtensionTestRoots, env, {
    includeOpenClawRuntimeSetup: false,
  });
}

export default createExtensionFeishuVitestConfig();
