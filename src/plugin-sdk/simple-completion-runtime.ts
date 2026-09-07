/** Runtime SDK for simple completions and assistant text extraction. */
import { completeWithPreparedSimpleCompletionModelCore } from "../agents/simple-completion-execution.js";
import type { PreparedSimpleCompletionModelForAgent } from "../agents/simple-completion-runtime.js";
import { getModelCompletionTransport } from "../llm/model-runtime-binding.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createLazyRuntimeMethod } from "../shared/lazy-runtime.js";
import { withLegacyPluginSdkResourceScope } from "./legacy-registry-resource-scope.js";

/** Preparation owns model/auth discovery; prepared execution must not cold-load it. */
export const acquireSimpleCompletionModelForAgent: typeof import("../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent =
  createLazyRuntimeMethod(
    () => import("../agents/simple-completion-runtime.js"),
    (runtime) => runtime.acquireSimpleCompletionModelForAgent,
  );
export type { AcquiredSimpleCompletionModelForAgent } from "../agents/simple-completion-runtime.js";
export { extractEmbeddedAssistantText as extractAssistantText } from "../agents/embedded-agent-utils.js";
export { runHostPreparedIsolatedCompletion } from "../agents/host-prepared-isolated-completion.js";

// SDK bundles share model ownership even when helpers load through different chunks.
const legacyModelHosts = resolveGlobalSingleton(
  Symbol.for("openclaw.legacySdkSimpleCompletionModelHosts"),
  () => new WeakMap<object, <T>(run: () => T) => T>(),
);

/**
 * @deprecated Use acquireSimpleCompletionModelForAgent and release after all completions finish.
 * The shipped bare-model API retains its generation until host close/restart. Standalone
 * callers without a host lifecycle retain the original process-lifetime contract.
 */
export async function prepareSimpleCompletionModelForAgent(
  params: Parameters<typeof acquireSimpleCompletionModelForAgent>[0],
): Promise<PreparedSimpleCompletionModelForAgent> {
  return await withLegacyPluginSdkResourceScope(async (_resources, retain, runInHost) => {
    const prepared = await acquireSimpleCompletionModelForAgent(params);
    if ("error" in prepared) {
      return prepared;
    }
    retain(prepared);
    legacyModelHosts.set(prepared.model, runInHost);
    const { release: _release, ...legacyPrepared } = prepared;
    return legacyPrepared;
  });
}

/** Direct bare-model callers retain the shipped shared-transport host lifetime. */
export async function completeWithPreparedSimpleCompletionModel(
  params: Parameters<typeof completeWithPreparedSimpleCompletionModelCore>[0],
) {
  const legacyHost = legacyModelHosts.get(params.model);
  if (legacyHost) {
    return await legacyHost(() => completeWithPreparedSimpleCompletionModelCore(params));
  }
  if (getModelCompletionTransport(params.model)) {
    return await completeWithPreparedSimpleCompletionModelCore(params);
  }
  return await withLegacyPluginSdkResourceScope(() =>
    completeWithPreparedSimpleCompletionModelCore(params),
  );
}
