/**
 * Runtime SDK subpath for simple model completions and assistant text extraction.
 */
export {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../agents/simple-completion-runtime.js";
export { extractAssistantText } from "../agents/embedded-agent-utils.js";
