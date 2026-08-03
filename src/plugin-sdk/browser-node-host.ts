/**
 * Public SDK facade for invoking browser plugin node-host proxy commands.
 */
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type BrowserNodeHostFacadeModule = {
  runBrowserProxyCommand(paramsJSON?: string | null): Promise<string>;
};

function loadFacadeModule(): BrowserNodeHostFacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<BrowserNodeHostFacadeModule>({
    dirName: "browser",
    artifactBasename: "runtime-api.js",
  });
}

/** Runs a serialized browser proxy command through the activated browser plugin facade. */
export async function runBrowserProxyCommand(paramsJSON?: string | null): Promise<string> {
  return await loadFacadeModule().runBrowserProxyCommand(paramsJSON);
}
