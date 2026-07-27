/**
 * Public Anthropic Vertex API barrel. It exposes lightweight discovery helpers
 * and lazy stream factories without eagerly importing the Vertex SDK runtime.
 */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { AnthropicVertexStreamDeps } from "./stream-runtime.js";

export {
  ANTHROPIC_VERTEX_DEFAULT_MODEL_ID,
  buildAnthropicVertexProvider,
} from "./provider-catalog.js";
export {
  mergeImplicitAnthropicVertexProvider,
  resolveImplicitAnthropicVertexProvider,
} from "./provider-catalog-runtime.js";
export {
  hasAnthropicVertexAvailableAuth,
  hasAnthropicVertexCredentials,
  resolveAnthropicVertexClientRegion,
  resolveAnthropicVertexConfigApiKey,
  resolveAnthropicVertexProjectId,
  resolveAnthropicVertexRegion,
  resolveAnthropicVertexRegionFromBaseUrl,
} from "./region.js";

const loadStreamRuntimeModule = createLazyRuntimeModule(() => import("./stream-runtime.js"));

/** Create a lazy Anthropic Vertex stream function for a known project/region/base URL. */
export function createAnthropicVertexStreamFn(
  projectId: string | undefined,
  region: string,
  baseURL?: string,
  deps?: AnthropicVertexStreamDeps,
): StreamFn {
  const streamFnPromise = loadStreamRuntimeModule().then((runtime) =>
    runtime.createAnthropicVertexStreamFn(projectId, region, baseURL, deps),
  );
  return async (model, context, options) => {
    const streamFn = await streamFnPromise;
    return streamFn(model, context, options);
  };
}

/** Create a lazy Anthropic Vertex stream function using model base URL and env hints. */
export function createAnthropicVertexStreamFnForModel(
  model: { baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
  deps?: AnthropicVertexStreamDeps,
): StreamFn {
  const streamFnPromise = loadStreamRuntimeModule().then((runtime) =>
    runtime.createAnthropicVertexStreamFnForModel(model, env, deps),
  );
  return async (...args) => {
    const streamFn = await streamFnPromise;
    return streamFn(...args);
  };
}
