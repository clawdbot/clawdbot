import type { PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import { getCachedPluginJitiLoader } from "./jiti-loader-cache.js";

export type PluginSourceLoader = (modulePath: string) => unknown;

function shouldProfilePluginSourceLoader(): boolean {
  return process.env.OPENCLAW_PLUGIN_LOAD_PROFILE === "1";
}

export function createPluginSourceLoader(): PluginSourceLoader {
  const loaders: PluginJitiLoaderCache = new Map();
  return (modulePath) => {
    const jiti = getCachedPluginJitiLoader({
      cache: loaders,
      modulePath,
      importerUrl: import.meta.url,
      jitiFilename: import.meta.url,
    });
    if (!shouldProfilePluginSourceLoader()) {
      return jiti(modulePath);
    }
    const startMs = performance.now();
    try {
      return jiti(modulePath);
    } finally {
      console.error(
        `[plugin-load-profile] phase=source-loader plugin=(direct) elapsedMs=${(performance.now() - startMs).toFixed(1)} source=${modulePath}`,
      );
    }
  };
}
