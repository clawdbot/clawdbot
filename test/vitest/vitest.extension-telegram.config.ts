import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension telegram config wires the extension telegram test shard.
import { telegramExtensionTestRoots } from "./vitest.extension-telegram-paths.mjs";

export function createExtensionTelegramVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("telegram", telegramExtensionTestRoots, env, {
    fileParallelism: false,
    isolate: true,
  });
}

export default createExtensionTelegramVitestConfig();
