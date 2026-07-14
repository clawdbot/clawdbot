/**
 * Public OpenAI transport surface.
 *
 * Responses and Chat Completions own independent streaming implementations. This facade keeps the
 * established imports stable while sharing only transport-neutral primitives between them.
 */
import type { Context } from "../llm/types.js";
import {
  buildOpenAICompletionsParams as buildOpenAICompletionsParamsImpl,
  completionsTesting,
} from "./openai-completions-transport.js";
import { responsesTesting } from "./openai-responses-transport.js";
import type { OpenAICompletionsOptions, OpenAIModeModel } from "./openai-transport-shared.js";

export { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
export {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-transport.js";

// Keep this SDK-exported declaration anchored to the long-lived facade while the
// completions implementation remains independently owned.
export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
): Record<string, unknown> {
  return buildOpenAICompletionsParamsImpl(model, context, options);
}

export const testing = {
  ...responsesTesting,
  ...completionsTesting,
};
export { testing as __testing };
