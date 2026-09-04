import path from "node:path";
// Vitest extension provider openai config wires the extension provider openai test shard.
import type { ViteUserConfig } from "vitest/config";
import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
import { providerOpenAiExtensionTestRoots } from "./vitest.extension-provider-paths.mjs";
import { repoRoot } from "./vitest.shared.config.ts";

export function createExtensionProviderOpenAiVitestConfig(
  env: Record<string, string | undefined> = process.env,
): ViteUserConfig {
  const config = createExtensionVitestConfig(
    "provider-openai",
    providerOpenAiExtensionTestRoots,
    env,
  );
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: [
        ...(Array.isArray(config.resolve?.alias) ? config.resolve.alias : []),
        {
          find: /^ws$/u,
          replacement: path.join(repoRoot, "node_modules", "ws", "wrapper.mjs"),
        },
      ],
    },
  };
}

export default createExtensionProviderOpenAiVitestConfig();
