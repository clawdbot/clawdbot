const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /^reply session initialization conflicted for \S+$/u;
const DISCORD_SESSION_CONFLICT_FAILURE_TEXT =
  "⚠️ Couldn't process this message because the session stayed busy. Please try again in a moment.";

type TerminalFailureDelivery = (
  payload: { text: string; isError: true },
  info: { kind: "final" },
) => Promise<unknown>;
type DeliveryErrorHandler = (error: unknown, info: { kind: string }) => void;

function isReplySessionInitConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(message);
}

export async function completeDiscordSessionConflict(
  error: unknown,
  deliver: TerminalFailureDelivery,
  onDeliveryError: DeliveryErrorHandler,
): Promise<boolean> {
  if (!isReplySessionInitConflictError(error)) {
    return false;
  }
  try {
    await deliver(
      { text: DISCORD_SESSION_CONFLICT_FAILURE_TEXT, isError: true },
      { kind: "final" },
    );
    return true;
  } catch (deliveryError) {
    // Keep the conflict retryable when its visible terminal notice cannot land.
    onDeliveryError(deliveryError, { kind: "final" });
    throw new Error(
      `discord: reply session init conflict exhausted and terminal notice failed: ${String(deliveryError)}`,
      { cause: deliveryError },
    );
  }
}

export function removeDiscordReplayHistoryEntry<T extends { messageId?: string }>(
  historyMap: Map<string, T[]>,
  historyKey: string,
  messageId: string,
): void {
  const history = historyMap.get(historyKey);
  if (!history) {
    return;
  }
  // An exhausted dispatch can release its replay claim after pending history
  // was recorded. Remove that copy before rebuilding the same inbound turn.
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.messageId === messageId) {
      history.splice(index, 1);
    }
  }
}
