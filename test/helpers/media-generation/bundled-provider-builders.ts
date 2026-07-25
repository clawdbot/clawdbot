// Media generation provider builders create bundled provider fixtures for tests.
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { loadBundledPluginPublicSurface } from "../../../src/test-utils/bundled-plugin-public-surface.js";

// Public-surface loader for bundled media provider plugin tests.

type BundledPluginEntryModule = {
  default: {
    register(api: OpenClawPluginApi): void;
  };
};

/** Load a bundled provider plugin entrypoint through the public surface helper. */
export async function loadBundledProviderPlugin(
  pluginId: string,
): Promise<BundledPluginEntryModule["default"]> {
  const module = await loadBundledPluginPublicSurface<BundledPluginEntryModule>({
    pluginId,
    artifactBasename: "index.js",
  });
  return module.default;
}
