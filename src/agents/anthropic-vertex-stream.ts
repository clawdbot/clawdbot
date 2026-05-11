import type { StreamFn } from "@earendil-works/pi-agent-core";
import { loadBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-loader.js";

type AnthropicVertexStreamFacade = {
  createAnthropicVertexStreamFn: (
    projectId: string | undefined,
    region: string,
    baseURL?: string,
  ) => StreamFn;
  createAnthropicVertexStreamFnForModel: (
    model: { baseUrl?: string },
    env?: NodeJS.ProcessEnv,
  ) => StreamFn;
};

function loadAnthropicVertexStreamFacade(): AnthropicVertexStreamFacade {
  return loadBundledPluginPublicSurfaceModuleSync<AnthropicVertexStreamFacade>({
    dirName: "anthropic-vertex",
    artifactBasename: "api.js",
  });
}

export function createAnthropicVertexStreamFnForModel(
  model: { baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): StreamFn {
  return loadAnthropicVertexStreamFacade().createAnthropicVertexStreamFnForModel(model, env);
}
