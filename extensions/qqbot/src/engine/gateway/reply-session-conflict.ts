// Shared detection, error-ID, and terminal-notice helpers for
// reply-session-init conflicts.
//
// ReplySessionInitConflictError is not exported through the plugin SDK, so
// every channel that needs to surface it must match the message pattern.

import {
  accountToCreds,
  buildDeliveryTarget,
  sendText as senderSendText,
} from "../messaging/sender.js";
import type { QueuedMessage } from "./message-queue.js";
import type { EngineLogger, GatewayAccount } from "./types.js";

const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /^reply session initialization conflicted for \S+$/u;

/** True when `error` matches the shared core's `ReplySessionInitConflictError`. */
export function isReplySessionInitConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(message);
}

/** Short hex reference number for correlating logs with user-visible notices. */
function generateSessionConflictErrorId(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!.toString(16).padStart(8, "0");
}

/** Dependencies injected to keep the function testable without a full gateway. */
interface SessionConflictTerminalNoticeDeps {
  event: QueuedMessage;
  account: GatewayAccount;
  log?: EngineLogger;
  senderSendText: typeof senderSendText;
  buildDeliveryTargetFn: typeof buildDeliveryTarget;
  accountToCredsFn: typeof accountToCreds;
}

/**
 * Evaluates the outcome decision for an inbound processing error.
 *
 * - `conflict + durable`: skip terminal notice so the queue can abandon and replay the durable claim.
 * - `conflict + non-durable`: send terminal notice (no replay owner).
 * - `non-conflict + durable`: skip terminal notice, rethrow for queue error/lifecycle handling.
 * - `non-conflict + non-durable`: skip terminal notice, error is swallowed by gateway catch.
 *
 * Non-durable events resolve normally after sending a terminal notice (for conflicts) or swallowing the error.
 * Durable events re-throw the original error so the message queue lifecycle can perform abandonment and replay.
 */
export async function handleInboundProcessingError(
  err: unknown,
  deps: SessionConflictTerminalNoticeDeps,
): Promise<void> {
  const isDurable = deps.event.turnAdoptionLifecycle !== undefined;
  const isConflict = isReplySessionInitConflictError(err);

  if (isConflict && !isDurable) {
    await sendReplySessionConflictTerminalNotice(err, deps);
  }

  if (isDurable) {
    throw err;
  }
}

/**
 * When shared-core retry ([#105754]) has exhausted, surface a best-effort
 * terminal notice to the QQ user.  The notice is deliberately terse and
 * carries an 8-char hex error reference for log correlation.  No internal
 * error text, session keys, or stack traces are exposed.
 *
 * If the terminal notice itself fails to send, the failure is logged at
 * ``terminal_notice_failed`` and the session's inbound work completes with
 * no delivery.  Notice send is never retried and never replaces the
 * original error — durable ingress is the only replay owner.
 *
 * Durable replay boundary: when `event.turnAdoptionLifecycle` is present,
 * the message queue's `processOne` catch will call `onAbandoned()` to
 * return the durable claim for replay.  Sending a terminal notice before
 * that replay would mislead the user (they would see a failure notice
 * before the same message could be retried successfully).  Callers must
 * perform the durable-lifecycle check before invoking this helper so
 * durable events never receive a notice — see `gateway.ts:handleMessage`.
 */
async function sendReplySessionConflictTerminalNotice(
  error: unknown,
  deps: SessionConflictTerminalNoticeDeps,
): Promise<void> {
  if (!isReplySessionInitConflictError(error)) {
    return;
  }
  const {
    event,
    account,
    log,
    senderSendText: senderSendTextFn,
    buildDeliveryTargetFn,
    accountToCredsFn,
  } = deps;
  const errorId = generateSessionConflictErrorId();
  const terminalText = `当前消息因会话冲突未能处理，请重新发送。\n错误编号：${errorId}`;

  log?.error(
    `reply session init conflict exhausted — ` +
      `messageId=${event.messageId} ` +
      `senderId=${event.senderId} ` +
      `groupOpenid=${event.groupOpenid ?? ""} ` +
      `errorId=${errorId}`,
  );

  try {
    await senderSendTextFn(buildDeliveryTargetFn(event), terminalText, accountToCredsFn(account), {
      msgId: event.messageId,
    });
  } catch (sendErr) {
    const sendErrDetail = sendErr instanceof Error ? sendErr.message : String(sendErr);
    log?.error(
      `terminal_notice_failed — errorId=${errorId} ` +
        `messageId=${event.messageId}: ` +
        sendErrDetail,
    );
  }
}
