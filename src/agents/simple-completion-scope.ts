import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";

type SimpleCompletionModelResolver = typeof resolveModelAsync;

export type PreparedSimpleCompletionResolverContext = Readonly<{
  modelResolver: SimpleCompletionModelResolver;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  workspaceDir: string;
}>;

/** Bind every resolution in one completion to one prepared generation and store pair. */
export function createPreparedSimpleCompletionResolverContext(params: {
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  workspaceDir: string;
  modelResolver?: SimpleCompletionModelResolver;
  agentRuntimeId?: string;
}): PreparedSimpleCompletionResolverContext {
  const stores = params.preparedModelRuntime.createStores();
  const modelResolver = params.modelResolver ?? resolveModelAsync;
  return {
    preparedModelRuntime: params.preparedModelRuntime,
    workspaceDir: params.workspaceDir,
    modelResolver: (provider, modelId, agentDir, cfg, options) =>
      modelResolver(provider, modelId, agentDir, cfg, {
        ...options,
        authStorage: stores.authStorage,
        modelRegistry: stores.modelRegistry,
        preparedModelRuntime: params.preparedModelRuntime,
        workspaceDir: params.workspaceDir,
        ...(params.agentRuntimeId ? { agentRuntimeId: params.agentRuntimeId } : {}),
      }),
  };
}
