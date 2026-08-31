/**
 * Agent hook history window helpers.
 *
 * Hook contexts include recent conversation history plus current-turn messages;
 * these helpers bound history size before plugin hooks receive it.
 */
/** Maximum prior messages included in agent hook history. */
export const MAX_AGENT_HOOK_HISTORY_MESSAGES = 100;

/** Builds hook-visible conversation messages from bounded history plus current turn. */
export function buildAgentHookConversationMessages(params: {
  historyMessages?: readonly unknown[];
  currentTurnMessages?: readonly unknown[];
}): unknown[] {
  return [
    ...(params.historyMessages?.slice(-MAX_AGENT_HOOK_HISTORY_MESSAGES) ?? []),
    ...(params.currentTurnMessages ?? []),
  ];
}
