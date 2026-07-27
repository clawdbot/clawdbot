/**
 * Public SDK facade for Anthropic Vertex implicit provider discovery and config helpers.
 */
import type { ModelProviderConfig } from "../config/types.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type FacadeModule = {
  resolveAnthropicVertexClientRegion: (params?: {
    baseUrl?: string;
    env?: NodeJS.ProcessEnv;
  }) => string;
  resolveAnthropicVertexProjectId: (env?: NodeJS.ProcessEnv) => string | undefined;
  buildAnthropicVertexProvider: (params?: { env?: NodeJS.ProcessEnv }) => ModelProviderConfig;
  resolveImplicitAnthropicVertexProvider: (params?: {
    env?: NodeJS.ProcessEnv;
  }) => ModelProviderConfig | null;
  mergeImplicitAnthropicVertexProvider: (params: {
    existing?: ModelProviderConfig;
    implicit: ModelProviderConfig;
  }) => ModelProviderConfig;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "anthropic-vertex",
    artifactBasename: "api.js",
  });
}

/** Resolves the Anthropic Vertex region through the activated bundled provider facade. */
export const resolveAnthropicVertexClientRegion: FacadeModule["resolveAnthropicVertexClientRegion"] =
  ((...args) =>
    loadFacadeModule().resolveAnthropicVertexClientRegion(
      ...args,
    )) as FacadeModule["resolveAnthropicVertexClientRegion"];

/** Resolves the Anthropic Vertex project id through the activated provider facade. */
export const resolveAnthropicVertexProjectId: FacadeModule["resolveAnthropicVertexProjectId"] = ((
  ...args
) =>
  loadFacadeModule().resolveAnthropicVertexProjectId(
    ...args,
  )) as FacadeModule["resolveAnthropicVertexProjectId"];
