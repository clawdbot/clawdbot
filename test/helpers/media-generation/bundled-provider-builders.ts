// Media generation provider builders create bundled provider fixtures for tests.
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { loadBundledPluginPublicSurfaceSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

// Public-surface loader for bundled media provider plugin tests.

type BundledPluginEntryModule = {
  default: {
    register(api: OpenClawPluginApi): void;
  };
};

/** Load a bundled provider plugin entrypoint through the public surface helper. */
export function loadBundledProviderPlugin(pluginId: string): BundledPluginEntryModule["default"] {
  return loadBundledPluginPublicSurfaceSync<BundledPluginEntryModule>({
    pluginId,
    artifactBasename: "index.js",
  }).default;
}
