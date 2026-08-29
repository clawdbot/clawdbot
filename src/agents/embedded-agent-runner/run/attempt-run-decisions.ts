/**
 * Resolves per-attempt runtime decisions from config and channel context.
 */
import type { EmbeddedRunAttemptParams } from "./types.js";

/**
 * Returns the auth profile id that should be attached to model-stream
 * provenance. Only runtime-forwarded ids are exposed; raw request auth ids can
 * represent local caller state rather than provider-visible credentials.
 */
export function resolveAttemptStreamAuthProfileId(
  params: Pick<EmbeddedRunAttemptParams, "authProfileId" | "runtimePlan">,
): string | undefined {
  return params.runtimePlan?.auth.forwardedAuthProfileId;
}

/**
 * Skips `llm_output` hooks only when `before_agent_run` blocked the prompt
 * before any model submission; later prompt errors can still have model output
 * or tool state that downstream hooks need to observe.
 */
export function shouldRunLlmOutputHooksForAttempt(params: { promptErrorSource: string | null }) {
  return params.promptErrorSource !== "hook:before_agent_run";
}

/**
 * Chooses the provider label used by tool-policy messages. Message providers
 * are more specific than transport channels, while channel remains the fallback
 * for older callers that do not split those concepts.
 */
export function resolveAttemptToolPolicyMessageProvider(params: {
  messageProvider?: string;
  messageChannel?: string;
}): string | undefined {
  return params.messageProvider ?? params.messageChannel;
}
