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
  hasAnthropicVertexAvailableAuth,
  hasAnthropicVertexCredentials,
  resolveAnthropicVertexClientRegion,
  resolveAnthropicVertexConfigApiKey,
  resolveAnthropicVertexProjectId,
  resolveAnthropicVertexRegion,
  resolveAnthropicVertexRegionFromBaseUrl,
} from "./region.js";
import { buildAnthropicVertexProvider } from "./provider-catalog.js";
import { hasAnthropicVertexAvailableAuth } from "./region.js";

const loadStreamRuntimeModule = createLazyRuntimeModule(() => import("./stream-runtime.js"));

/** Merge an implicit Anthropic Vertex provider with explicit user config. */
export function mergeImplicitAnthropicVertexProvider(params: {
  existing?: ReturnType<typeof buildAnthropicVertexProvider>;
  implicit: ReturnType<typeof buildAnthropicVertexProvider>;
}) {
  const { existing, implicit } = params;
  if (!existing) {
    return implicit;
  }
  return {
    ...implicit,
    ...existing,
    models:
      Array.isArray(existing.models) && existing.models.length > 0
        ? existing.models
        : implicit.models,
  };
}

/** Resolve an implicit Anthropic Vertex provider when ADC credentials are available. */
export function resolveImplicitAnthropicVertexProvider(params?: { env?: NodeJS.ProcessEnv }) {
  const env = params?.env ?? process.env;
  if (!hasAnthropicVertexAvailableAuth(env)) {
    return null;
  }

  return buildAnthropicVertexProvider({ env });
}

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
