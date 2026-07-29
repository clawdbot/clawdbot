/**
 * Agent hook history window helpers.
 *
 * Hook contexts include recent conversation history plus current-turn messages;
 * these helpers bound history size before plugin hooks receive it.
 */
/** Maximum prior messages included in agent hook history. */
export const MAX_AGENT_HOOK_HISTORY_MESSAGES = 100;

/** Returns the tail of hook history capped at the configured maximum. */
export function limitAgentHookHistoryMessages(
  messages: readonly unknown[],
  maxMessages = MAX_AGENT_HOOK_HISTORY_MESSAGES,
): unknown[] {
  if (maxMessages <= 0) {
    return [];
  }
  return messages.slice(-maxMessages);
}

/** Builds hook-visible conversation messages from bounded history plus current turn. */
export function buildAgentHookConversationMessages(params: {
  historyMessages?: readonly unknown[];
  currentTurnMessages?: readonly unknown[];
}): unknown[] {
  return [
    ...limitAgentHookHistoryMessages(params.historyMessages ?? []),
    ...(params.currentTurnMessages ?? []),
  ];
}
