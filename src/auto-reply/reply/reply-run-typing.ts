import { runAfterReplyOperationClear, type ReplyOperation } from "./reply-run-registry.js";
import type { TypingController } from "./typing.js";

const typingByReplyOperation = new WeakMap<ReplyOperation, TypingController>();

/** Keep one feedback controller attached to the task that owns a reply run. */
export function bindReplyOperationTyping(
  operation: ReplyOperation,
  typing: TypingController,
): void {
  if (typingByReplyOperation.has(operation)) {
    return;
  }
  typingByReplyOperation.set(operation, typing);
  runAfterReplyOperationClear(operation, () => {
    if (typingByReplyOperation.get(operation) !== typing) {
      return;
    }
    typingByReplyOperation.delete(operation);
    typing.cleanup();
  });
}

/** Refresh the continuing task's feedback after it adopts another inbound turn. */
export async function refreshReplyOperationTyping(
  operation: ReplyOperation,
  options: { startIfIdle: boolean },
): Promise<void> {
  const typing = typingByReplyOperation.get(operation);
  if (!typing || operation.result || (!options.startIfIdle && !typing.isActive())) {
    return;
  }
  await typing.startTypingLoop();
}
