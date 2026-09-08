/** Runtime SDK subpath for prepared completions and assistant text extraction. */
import { createLazyRuntimeMethod } from "../shared/lazy-runtime.js";

export { completeWithPreparedSimpleCompletionModel } from "../agents/simple-completion-execution.js";
export { extractEmbeddedAssistantText as extractAssistantText } from "../agents/embedded-agent-utils.js";
export { runHostPreparedIsolatedCompletion } from "../agents/host-prepared-isolated-completion.js";

/** Preparation owns model/auth discovery; prepared execution must not cold-load it. */
export const prepareSimpleCompletionModelForAgent: typeof import("../agents/simple-completion-runtime.js").prepareSimpleCompletionModelForAgent =
  createLazyRuntimeMethod(
    () => import("../agents/simple-completion-runtime.js"),
    (runtime) => runtime.prepareSimpleCompletionModelForAgent,
  );
