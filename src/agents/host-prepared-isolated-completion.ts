import type {
  AgentHarnessIsolatedCompletionParamsV2,
  AgentHarnessIsolatedCompletionResult,
} from "./harness/types.js";
import { completeWithPreparedSimpleCompletionModel } from "./simple-completion-runtime.js";

/** Executes one zero-tool completion using the exact host-prepared model and credential. */
export async function runHostPreparedIsolatedCompletion(
  params: AgentHarnessIsolatedCompletionParamsV2,
): Promise<AgentHarnessIsolatedCompletionResult> {
  if (params.authorization.owner !== "host") {
    throw new Error("Isolated completion requires host-prepared authorization.");
  }
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs);
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, timeoutSignal])
    : timeoutSignal;
  const assistant = await completeWithPreparedSimpleCompletionModel({
    model: params.authorization.model,
    auth: params.authorization.auth,
    cfg: params.config,
    context: {
      systemPrompt: params.systemPrompt,
      messages: [{ role: "user", content: params.prompt, timestamp: Date.now() }],
      tools: [],
    },
    options: {
      maxTokens: params.streamParams?.maxTokens,
      temperature: params.streamParams?.temperature,
      reasoning: params.thinkLevel,
      // Title callers must select strict parsing before transport recovery loses tag provenance.
      strictReasoningTags: params.outputTextPolicy === "strict-visible",
      signal,
    },
  });
  return { assistant };
}
