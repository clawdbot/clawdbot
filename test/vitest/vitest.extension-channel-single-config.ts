// Vitest extension channel single config helper supports extension channel single config test configuration.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createSingleChannelExtensionVitestConfig(
  extensionId: string,
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig([`extensions/${extensionId}/**/*.test.ts`], {
    dir: "extensions",
    env,
    name: `extension-${extensionId}`,
    passWithNoTests: true,
    setupFiles: ["test/setup.extensions.ts"],
  });
}

export default function createSingleChannelExtensionHelperVitestConfig() {
  return createScopedVitestConfig(["extensions/__single-channel-config-helper__/**/*.test.ts"], {
    dir: "extensions",
    name: "extension-channel-single-config",
    passWithNoTests: true,
    setupFiles: ["test/setup.extensions.ts"],
  });
}
