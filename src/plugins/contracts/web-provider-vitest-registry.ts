import { loadBundledPluginPublicSurfaceSync } from "../../test-utils/bundled-plugin-public-surface.js";
import type { WebSearchProviderPlugin } from "../types.js";

export type WebSearchProviderContractEntry = {
  pluginId: string;
  provider: WebSearchProviderPlugin;
  credentialValue: unknown;
};

let webSearchProviderContractRegistryCache: WebSearchProviderContractEntry[] | null = null;

type GoogleWebSearchContractApiSurface =
  typeof import("../../../extensions/google/web-search-contract-api.js");

export function loadVitestWebSearchProviderContractRegistry(): WebSearchProviderContractEntry[] {
  const googleWebSearchContractApi =
    loadBundledPluginPublicSurfaceSync<GoogleWebSearchContractApiSurface>({
      pluginId: "google",
      artifactBasename: "web-search-contract-api.js",
    });
  webSearchProviderContractRegistryCache ??= [
    {
      pluginId: "google",
      provider: googleWebSearchContractApi.createGeminiWebSearchProvider(),
      credentialValue: "AIzaSyDUMMY",
    },
  ];
  return webSearchProviderContractRegistryCache;
}
