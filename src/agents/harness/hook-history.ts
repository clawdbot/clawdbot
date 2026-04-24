export const MAX_AGENT_HOOK_HISTORY_MESSAGES = 100;

export function limitAgentHookHistoryMessages(
  messages: readonly unknown[],
  maxMessages = MAX_AGENT_HOOK_HISTORY_MESSAGES,
): unknown[] {
  if (maxMessages <= 0) {
    return [];
  }
  return messages.slice(-maxMessages);
}

export function buildAgentHookConversationMessages(params: {
  historyMessages?: readonly unknown[];
  currentTurnMessages?: readonly unknown[];
}): unknown[] {
  return [
    ...limitAgentHookHistoryMessages(params.historyMessages ?? []),
    ...(params.currentTurnMessages ?? []),
  ];
}
