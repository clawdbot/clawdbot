// Feishu plugin module implements typing behavior.
import { collectErrorGraphCandidates } from "openclaw/plugin-sdk/error-runtime";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  FeishuBackoffError,
  getBackoffCodeFromResponse,
  isFeishuBackoffError,
} from "./typing-backoff.js";

// Feishu emoji types for typing indicator
// See: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
// Full list: https://github.com/go-lark/lark/blob/main/emoji.go
const TYPING_EMOJI = "Typing"; // Typing indicator emoji
const FEISHU_MESSAGE_NOT_FOUND_CODE = 231003;

/** Detect Feishu's recalled/deleted message code across SDK and Axios error shapes. */
function isFeishuMessageNotFoundError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [
    current.cause,
    current.response,
    current.data,
    ...(Array.isArray(current) ? current : []),
  ]).some((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }
    return (candidate as { code?: unknown }).code === FEISHU_MESSAGE_NOT_FOUND_CODE;
  });
}

export type TypingIndicatorState = {
  messageId: string;
  reactionId: string | null;
};

type FeishuMessageReactionCreateResponse = Awaited<
  ReturnType<ReturnType<typeof createFeishuClient>["im"]["messageReaction"]["create"]>
>;

/**
 * Add a typing indicator (reaction) to a message.
 *
 * Rate-limit and quota errors are re-thrown so the circuit breaker in
 * `createTypingCallbacks` (typing-start-guard) can trip and stop the
 * keepalive loop. See #28062.
 *
 * Also checks for backoff codes in non-throwing SDK responses (#28157).
 */
export async function addTypingIndicator(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
  runtime?: RuntimeEnv;
  onMessageNotFound?: (messageId: string) => void | Promise<void>;
}): Promise<TypingIndicatorState> {
  const { cfg, messageId, accountId, runtime, onMessageNotFound } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    return { messageId, reactionId: null };
  }

  const client = createFeishuClient(account);
  const handleMessageNotFound = async (): Promise<TypingIndicatorState> => {
    await onMessageNotFound?.(messageId);
    if (getFeishuRuntime().logging.shouldLogVerbose()) {
      runtime?.log?.(`[feishu] typing target message not found: ${messageId}`);
    }
    return { messageId, reactionId: null };
  };

  try {
    const response = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: TYPING_EMOJI },
      },
    });

    // Feishu SDK may return a normal response with an API-level error code
    // instead of throwing. Detect backoff codes and throw to trip the breaker.
    const backoffCode = getBackoffCodeFromResponse(response);
    if (backoffCode !== undefined) {
      if (getFeishuRuntime().logging.shouldLogVerbose()) {
        runtime?.log?.(
          `[feishu] typing indicator response contains backoff code ${backoffCode}, stopping keepalive`,
        );
      }
      throw new FeishuBackoffError(backoffCode);
    }
    if (isFeishuMessageNotFoundError(response)) {
      return await handleMessageNotFound();
    }

    const typedResponse: FeishuMessageReactionCreateResponse = response;
    const reactionId = typedResponse.data?.reaction_id ?? null;
    return { messageId, reactionId };
  } catch (err) {
    if (isFeishuBackoffError(err)) {
      if (getFeishuRuntime().logging.shouldLogVerbose()) {
        runtime?.log?.("[feishu] typing indicator hit rate-limit/quota, stopping keepalive");
      }
      throw err;
    }
    if (isFeishuMessageNotFoundError(err)) {
      return await handleMessageNotFound();
    }
    // Silently fail for other non-critical errors (e.g. message deleted, permission issues)
    if (getFeishuRuntime().logging.shouldLogVerbose()) {
      runtime?.log?.(`[feishu] failed to add typing indicator: ${String(err)}`);
    }
    return { messageId, reactionId: null };
  }
}

/**
 * Remove a typing indicator (reaction) from a message.
 *
 * Rate-limit and quota errors are re-thrown for the same reason as above.
 */
export async function removeTypingIndicator(params: {
  cfg: ClawdbotConfig;
  state: TypingIndicatorState;
  accountId?: string;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const { cfg, state, accountId, runtime } = params;
  if (!state.reactionId) {
    return;
  }

  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    return;
  }

  const client = createFeishuClient(account);

  try {
    const result = await client.im.messageReaction.delete({
      path: {
        message_id: state.messageId,
        reaction_id: state.reactionId,
      },
    });

    // Check for backoff codes in non-throwing SDK responses
    const backoffCode = getBackoffCodeFromResponse(result);
    if (backoffCode !== undefined) {
      if (getFeishuRuntime().logging.shouldLogVerbose()) {
        runtime?.log?.(
          `[feishu] typing indicator removal response contains backoff code ${backoffCode}, stopping keepalive`,
        );
      }
      throw new FeishuBackoffError(backoffCode);
    }
  } catch (err) {
    if (isFeishuBackoffError(err)) {
      if (getFeishuRuntime().logging.shouldLogVerbose()) {
        runtime?.log?.(
          "[feishu] typing indicator removal hit rate-limit/quota, stopping keepalive",
        );
      }
      throw err;
    }
    // Silently fail for other non-critical errors
    if (getFeishuRuntime().logging.shouldLogVerbose()) {
      runtime?.log?.(`[feishu] failed to remove typing indicator: ${String(err)}`);
    }
  }
}
