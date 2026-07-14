// Discord plugin module implements narrow inbound dispatch retry behavior.
import { logVerbose, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { DiscordRetryableInboundError } from "./inbound-dedupe.js";

const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /^reply session initialization conflicted for \S+$/u;
const DISCORD_SESSION_INIT_CONFLICT_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;
const DISCORD_SESSION_CONFLICT_FAILURE_TEXT =
  "⚠️ Couldn't process this message because the session stayed busy. Please try again in a moment.";

type AsyncDispatch<TParams, TResult> = (params: TParams) => Promise<TResult>;
type TerminalFailureDelivery = (
  payload: { text: string; isError: true },
  info: { kind: "final" },
) => Promise<unknown>;
type DeliveryErrorHandler = (error: unknown, info: { kind: string }) => void;

function isReplySessionInitConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(message);
}

class DiscordReplySessionConflictExhaustedError extends DiscordRetryableInboundError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiscordReplySessionConflictExhaustedError";
  }
}

async function dispatchDiscordReplyWithSessionConflictRetry<T>(params: {
  dispatch: () => Promise<T>;
  abortSignal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number) => void;
}): Promise<T> {
  for (let retryIndex = 0; ; retryIndex += 1) {
    try {
      return await params.dispatch();
    } catch (error) {
      if (!isReplySessionInitConflictError(error)) {
        throw error;
      }
      const delayMs = DISCORD_SESSION_INIT_CONFLICT_RETRY_DELAYS_MS[retryIndex];
      if (delayMs === undefined) {
        const message = error instanceof Error ? error.message : String(error);
        // Let the caller either complete with a visible terminal notice or
        // reopen replay ownership when that notice cannot land.
        throw new DiscordReplySessionConflictExhaustedError(
          `discord: reply session init conflict persisted after shared and channel retries: ${message}`,
          { cause: error },
        );
      }
      params.onRetry?.(retryIndex + 1, delayMs);
      await sleepWithAbort(delayMs, params.abortSignal);
    }
  }
}

export function withDiscordSessionRetry<TParams, TResult>(
  dispatch: AsyncDispatch<TParams, TResult>,
  abortSignal: AbortSignal | undefined,
): AsyncDispatch<TParams, TResult> {
  return (dispatchParams) =>
    dispatchDiscordReplyWithSessionConflictRetry({
      dispatch: () => dispatch(dispatchParams),
      abortSignal,
      onRetry: (attempt, delayMs) => {
        logVerbose(
          `discord: reply session init conflict; retrying dispatch ${attempt} after ${delayMs}ms`,
        );
      },
    });
}

export async function completeDiscordSessionConflict(
  error: unknown,
  deliver: TerminalFailureDelivery,
  onDeliveryError: DeliveryErrorHandler,
): Promise<boolean> {
  if (!(error instanceof DiscordReplySessionConflictExhaustedError)) {
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
    return false;
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
