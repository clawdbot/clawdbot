// Control UI chat module owns lifting a queued message back into the composer.
import { chatQueueOrderKey, isMovableChatQueueItem } from "../../lib/chat/chat-queue-order.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  readQueuedMessageById,
  removeVisibleOrScopedQueuedMessageWithoutReleasing,
  type ChatQueueScopedSessionHost,
} from "./chat-queue.ts";

/**
 * The edited row stays in the queue, holding its own place, so the operator can
 * see where the message will land. This records which row the composer owns and
 * the position the replacement inherits.
 */
export type QueuedMessageEdit = {
  id: string;
  orderKey: number;
  sessionKey: string;
};

type QueuedMessageEditHost = ChatQueueScopedSessionHost & {
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueuedEdit?: QueuedMessageEdit | null;
};

/** Closed outcomes so the page owns the operator-visible wording. */
type QueuedMessageEditResult = "started" | "unavailable" | "composer-busy";

/**
 * The edit belongs to the session it started in. Reading it through here is what
 * makes that true everywhere — a pane showing another session sees no edit, so
 * no lifecycle hook has to remember to clear one.
 */
export function activeQueuedMessageEdit(host: QueuedMessageEditHost): QueuedMessageEdit | null {
  const edit = host.chatQueuedEdit;
  return edit && edit.sessionKey === host.sessionKey ? edit : null;
}

/** True for the one row the composer is currently editing. */
export function isQueuedMessageBeingEdited(host: QueuedMessageEditHost, id: string): boolean {
  return activeQueuedMessageEdit(host)?.id === id;
}

export function beginQueuedMessageEdit(
  host: QueuedMessageEditHost,
  id: string,
): QueuedMessageEditResult {
  const item = readQueuedMessageById(host, id);
  // Local slash commands take a different enqueue path that cannot carry a
  // resumed position, so they keep the discard-and-retype flow for now.
  if (
    !item ||
    !isMovableChatQueueItem(item) ||
    item.localCommandName ||
    activeQueuedMessageEdit(host)
  ) {
    return "unavailable";
  }
  // Never overwrite newer composer input; the same rule guards command recovery.
  if (host.chatMessage.trim() || host.chatAttachments.length > 0) {
    return "composer-busy";
  }
  // The row is left in storage on purpose: it keeps its place visibly, and the
  // drain refuses it while this edit owns it (see chat-outbox-drain).
  host.chatQueuedEdit = { id, orderKey: chatQueueOrderKey(item), sessionKey: host.sessionKey };
  host.chatMessage = item.text;
  host.chatAttachments = item.attachments ?? [];
  return "started";
}

/** Cancel touches storage not at all: the row never left the queue. */
export function cancelQueuedMessageEdit(host: QueuedMessageEditHost): boolean {
  if (!activeQueuedMessageEdit(host)) {
    return false;
  }
  host.chatQueuedEdit = null;
  host.chatMessage = "";
  host.chatAttachments = [];
  return true;
}

/**
 * A send that resumes an edit retires the original row and hands its position to
 * the replacement, which is what puts the corrected message back in the same
 * slot. Once the queue has drained, that position is simply the only one.
 */
export function consumeQueuedMessageEdit(
  host: QueuedMessageEditHost,
  sessionKey: string,
  nextAttachments: readonly ChatAttachment[] = [],
): number | undefined {
  const edit = host.chatQueuedEdit;
  if (!edit || edit.sessionKey !== sessionKey) {
    return undefined;
  }
  host.chatQueuedEdit = null;
  const removed = removeVisibleOrScopedQueuedMessageWithoutReleasing(
    host,
    edit.id,
    edit.sessionKey,
  );
  // Images the operator dropped during the edit lose their last owner here; the
  // ones the replacement still carries must survive, so release only the rest.
  const retained = new Set(nextAttachments.map((attachment) => attachment.id));
  releaseChatAttachmentPayloads(
    (removed?.attachments ?? []).filter((attachment) => !retained.has(attachment.id)),
  );
  return edit.orderKey;
}
