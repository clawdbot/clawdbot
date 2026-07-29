/** Builds a stable internal hook event payload for tests that do not need full messages. */
export function createInternalHookEventPayload(
  type: string,
  action: string,
  sessionKey: string,
  context: Record<string, unknown>,
) {
  return {
    type,
    action,
    sessionKey,
    context,
    timestamp: new Date(),
    messages: [],
  };
}
