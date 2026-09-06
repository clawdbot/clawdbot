/** Runtime SDK subpath for prepared completions and assistant text extraction. */
export { completeWithPreparedSimpleCompletionModel } from "../agents/simple-completion-execution.js";
export { extractEmbeddedAssistantText as extractAssistantText } from "../agents/embedded-agent-utils.js";
export { runHostPreparedIsolatedCompletion } from "../agents/host-prepared-isolated-completion.js";

/** Preparation owns model/auth discovery; prepared execution must not cold-load it. */
export async function prepareSimpleCompletionModelForAgent(
  params: Parameters<
    typeof import("../agents/simple-completion-runtime.js").prepareSimpleCompletionModelForAgent
  >[0],
): ReturnType<
  typeof import("../agents/simple-completion-runtime.js").prepareSimpleCompletionModelForAgent
> {
  const { prepareSimpleCompletionModelForAgent: prepare } =
    await import("../agents/simple-completion-runtime.js");
  return prepare(params);
}
