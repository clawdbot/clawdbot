// Control UI chat module owns lifting a queued message back into the composer.
import { chatQueueOrderKey, isMovableChatQueueItem } from "../../lib/chat/chat-queue-order.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import {
  cloneChatAttachmentsForIndependentOwner,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  anyChatOutboxPaneMatches,
  isDurableQueuedMessage,
  readQueuedMessageById,
  removeVisibleOrScopedQueuedMessageWithoutReleasing,
  type ChatQueueScopedSessionHost,
} from "./chat-queue.ts";

/**
 * The edited row stays in the queue, holding its own place, so the operator can
 * see where the message will land. This records which row the composer owns, the
 * outbox scope that owns the row, the payloads that row still owns, and the
 * position the replacement inherits.
 */
export type QueuedMessageEdit = {
  agentId?: string;
  attachments: readonly ChatAttachment[];
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
 * The edit belongs to the scope it started in — session and agent, the pair every
 * outbox is keyed by. Reading it through here is what makes that true everywhere:
 * a pane showing another session, or the same raw global session after the
 * selected agent changed underneath it, sees no edit. So no lifecycle hook has to
 * remember to clear one, and no send can retire a row in the outbox it left.
 */
export function activeQueuedMessageEdit(host: QueuedMessageEditHost): QueuedMessageEdit | null {
  const edit = host.chatQueuedEdit;
  return edit && visibleSessionMatches(host, edit.sessionKey, edit.agentId) ? edit : null;
}

/**
 * True while any pane is editing the row. The composer that owns an edit is
 * pane-local, but the outbox and the drain are shared and either pane can own the
 * drain lane, so a hold that only its own pane could see would let the other one
 * deliver the text an operator is visibly rewriting.
 */
export function isQueuedMessageBeingEdited(host: QueuedMessageEditHost, id: string): boolean {
  return anyChatOutboxPaneMatches(host, (pane) => activeQueuedMessageEdit(pane)?.id === id);
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
  const agentId = scopedAgentIdForSession(host, host.sessionKey);
  // The payloads travel with the token because the row they belong to is gone by
  // the time the edit ends: the write that admits the replacement retires it.
  host.chatQueuedEdit = {
    ...(agentId ? { agentId } : {}),
    attachments: item.attachments ?? [],
    id,
    orderKey: chatQueueOrderKey(item),
    sessionKey: host.sessionKey,
  };
  host.chatMessage = item.text;
  host.chatAttachments = item.attachments ?? [];
  return "started";
}

/** Cancel touches storage not at all: the row never left the queue. */
export function cancelQueuedMessageEdit(host: QueuedMessageEditHost): boolean {
  const edit = activeQueuedMessageEdit(host);
  if (!edit) {
    return false;
  }
  // Keep the current draft visible, but fork any row-owned attachments so the
  // composer can keep editing even if the queued row later drains or is removed.
  const originalAttachmentIds = new Set(edit.attachments.map((attachment) => attachment.id));
  host.chatAttachments = host.chatAttachments.map((attachment) =>
    originalAttachmentIds.has(attachment.id)
      ? cloneChatAttachmentsForIndependentOwner([attachment])[0]!
      : attachment,
  );
  host.chatQueuedEdit = null;
  return true;
}

/**
 * A send that resumes an edit inherits the row's position, which is what puts the
 * corrected message back in the same slot, and the durable admission retires the
 * source in the same store write (see `admitQueuedMessageForSession`). This
 * clears what that write left behind: the projection row and the payloads the
 * replacement dropped. A rejected write retires nothing, so the original stays
 * queued with its edit still open — what cancel already promises — and the caller
 * must not fall back to a memory-only send that would strand it. A source with no
 * stored copy has nothing to lose to a reload, so it retires with the memory row.
 */
export function retireEditedQueuedMessageSource(
  host: QueuedMessageEditHost,
  admittedDurably: boolean,
  nextAttachments: readonly ChatAttachment[] = [],
): void {
  const edit = activeQueuedMessageEdit(host);
  if (!edit || (!admittedDurably && isDurableQueuedMessage(host, edit.id))) {
    return;
  }
  host.chatQueuedEdit = null;
  removeVisibleOrScopedQueuedMessageWithoutReleasing(host, edit.id, edit.sessionKey);
  // Images the operator dropped during the edit lose their last owner here; the
  // ones the replacement still carries must survive, so release only the rest.
  // The payloads come from the token: a successful write already retired the row
  // and told every pane, so re-reading it here would find nothing to release.
  const retainedIds = new Set(nextAttachments.map((attachment) => attachment.id));
  const droppedAttachments = edit.attachments.filter(
    (attachment) => !retainedIds.has(attachment.id),
  );
  releaseChatAttachmentPayloads(droppedAttachments);
}
