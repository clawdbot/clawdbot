// Control UI chat module owns editing a queued message in its queue row.
import { chatQueueOrderKey, isMovableChatQueueItem } from "../../lib/chat/chat-queue-order.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  anyChatOutboxPaneMatches,
  isDurableQueuedMessage,
  readQueuedMessageById,
  removeVisibleOrScopedQueuedMessageWithoutReleasing,
  type ChatQueueScopedSessionHost,
} from "./chat-queue.ts";

/**
 * The edited row stays in the queue, holding its own place, so the operator can
 * see where the message will land. This records the row-local draft, the outbox
 * scope that owns the row, the payloads that row still owns, and the position
 * the replacement inherits.
 */
export type QueuedMessageEdit = {
  agentId?: string;
  attachments: readonly ChatAttachment[];
  draftText: string;
  id: string;
  orderKey: number;
  revision: number;
  replyToId?: string;
  sessionKey: string;
  source: ChatQueueItem;
  sourceWasDurable: boolean;
};

type QueuedMessageEditHost = ChatQueueScopedSessionHost & {
  chatQueuedEdit?: QueuedMessageEdit | null;
};

function queuedMessageEditSourceMatches(edit: QueuedMessageEdit, item: ChatQueueItem): boolean {
  return (
    item.id === edit.source.id &&
    item.sendRunId === edit.source.sendRunId &&
    item.sendAttempts === edit.source.sendAttempts &&
    item.sendState === edit.source.sendState &&
    item.agentId === edit.source.agentId &&
    item.sessionKey === edit.source.sessionKey &&
    item.orderKey === edit.source.orderKey
  );
}

/** Closed outcomes so the page owns the operator-visible wording. */
type QueuedMessageEditResult = "started" | "unavailable";

export const QUEUED_MESSAGE_EDIT_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before removing it.";
export const QUEUED_MESSAGE_REORDER_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before reordering it.";
export const QUEUED_MESSAGE_RETRY_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before retrying it.";
export const QUEUED_MESSAGE_STEER_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before steering it.";

/**
 * The edit belongs to the scope it started in — session and agent, the pair every
 * outbox is keyed by. Reading it through here is what makes that true everywhere:
 * a pane showing another session, or the same raw global session after the
 * selected agent changed underneath it, sees no edit. So no lifecycle hook has to
 * remember to clear one, and no send can retire a row in the outbox it left.
 */
export function activeQueuedMessageEdit(host: QueuedMessageEditHost): QueuedMessageEdit | null {
  const edit = host.chatQueuedEdit;
  if (!edit || !visibleSessionMatches(host, edit.sessionKey, edit.agentId)) {
    return null;
  }
  // Route changes intentionally release the edit hold so another pane can
  // drain or update the row. Do not revive a token whose source changed while
  // away: its replacement CAS would reject the stale captured version and
  // there would be no safe submit/cancel action to offer on return.
  const source = readQueuedMessageById(host, edit.id);
  if (!source || !queuedMessageEditSourceMatches(edit, source)) {
    host.chatQueuedEdit = null;
    return null;
  }
  return edit;
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

/** Removal is a conflicting shared-outbox action while any pane owns the row draft. */
export function isQueuedMessageRemovalBlocked(host: QueuedMessageEditHost, id: string): boolean {
  return isQueuedMessageBeingEdited(host, id);
}

/** Reordering is also conflicting: submit must not restore a stale position. */
export function isQueuedMessageReorderBlocked(host: QueuedMessageEditHost, id: string): boolean {
  return isQueuedMessageBeingEdited(host, id);
}

/** Retrying must not dispatch the source payload while another pane edits it. */
export function isQueuedMessageRetryBlocked(host: QueuedMessageEditHost, id: string): boolean {
  return isQueuedMessageBeingEdited(host, id);
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
    activeQueuedMessageEdit(host) ||
    isQueuedMessageBeingEdited(host, id)
  ) {
    return "unavailable";
  }
  // The row is left in storage on purpose: it keeps its place visibly, and the
  // drain refuses it while this edit owns it (see chat-outbox-drain). The draft
  // belongs to this token rather than the global composer, so editing a queued
  // row never overwrites text the operator is composing for a different send.
  const agentId = scopedAgentIdForSession(host, host.sessionKey);
  host.chatQueuedEdit = {
    ...(agentId ? { agentId } : {}),
    attachments: item.attachments ?? [],
    draftText: item.text,
    id,
    orderKey: chatQueueOrderKey(item),
    revision: 0,
    ...(item.replyToId ? { replyToId: item.replyToId } : {}),
    sessionKey: host.sessionKey,
    source: { ...item },
    sourceWasDurable: isDurableQueuedMessage(host, id),
  };
  return "started";
}

export function updateQueuedMessageEdit(host: QueuedMessageEditHost, draftText: string): boolean {
  const edit = activeQueuedMessageEdit(host);
  if (!edit) {
    return false;
  }
  edit.draftText = draftText;
  edit.revision += 1;
  return true;
}

/** Cancel touches storage not at all: the row never left the queue. */
export function cancelQueuedMessageEdit(host: QueuedMessageEditHost): boolean {
  const edit = activeQueuedMessageEdit(host);
  if (!edit) {
    return false;
  }
  // The durable row still owns its original payloads. The row-local draft has
  // no separate attachment owner, so cancellation has nothing to release or
  // copy and leaves the main composer exactly as it was.
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
  editOverride?: QueuedMessageEdit,
): void {
  const edit = editOverride ?? activeQueuedMessageEdit(host);
  if (editOverride && host.chatQueuedEdit !== edit) {
    return;
  }
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
  releaseChatAttachmentPayloads(
    edit.attachments.filter((attachment) => !retainedIds.has(attachment.id)),
  );
}
