import { withProfile } from "./plugin-load-profile.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginSourceModuleLoader,
} from "./plugin-module-loader-cache.js";

export type PluginSourceLoader = (modulePath: string) => unknown;

export function createPluginSourceLoader(): PluginSourceLoader {
  const loaders = createPluginModuleLoaderCache();
  return (modulePath) => {
    const sourceLoader = getCachedPluginSourceModuleLoader({
      cache: loaders,
      modulePath,
      importerUrl: import.meta.url,
      loaderFilename: import.meta.url,
    });
    // Direct source loads are not associated with a specific plugin id —
    // preserve the existing `plugin=(direct)` field used by tooling that
    // scrapes [plugin-load-profile] lines.
    return withProfile({ pluginId: "(direct)", source: modulePath }, "source-loader", () =>
      sourceLoader(modulePath),
    );
  };
}
