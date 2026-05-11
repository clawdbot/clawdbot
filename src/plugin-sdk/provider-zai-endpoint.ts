/**
 * @deprecated Z.AI provider-owned endpoint detection helper. Use the bundled
 * Z.AI plugin public API instead, or keep endpoint probing local to your
 * provider plugin.
 */

import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

export type ZaiEndpointId = "global" | "cn" | "coding-global" | "coding-cn";

export type ZaiDetectedEndpoint = {
  endpoint: ZaiEndpointId;
  baseUrl: string;
  modelId: string;
  note: string;
};

type DetectZaiEndpoint = (params: {
  apiKey: string;
  endpoint?: ZaiEndpointId;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}) => Promise<ZaiDetectedEndpoint | null>;

type FacadeModule = {
  detectZaiEndpoint: DetectZaiEndpoint;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "zai",
    artifactBasename: "api.js",
  });
}

/** @deprecated Z.AI provider-owned endpoint detection helper. */
export const detectZaiEndpoint: DetectZaiEndpoint = ((...args) =>
  loadFacadeModule().detectZaiEndpoint(...args)) as DetectZaiEndpoint;
