/**
 * Server-owned origin for one tool or message-action invocation.
 *
 * Missing and unknown values must remain delegated; callers must never derive
 * this from model arguments, provider parameters, config, or persisted state.
 */
export type ConversationReadInvocationOrigin = "delegated" | "direct-operator";

export function normalizeConversationReadInvocationOrigin(
  value: unknown,
): ConversationReadInvocationOrigin {
  return value === "direct-operator" ? "direct-operator" : "delegated";
}
