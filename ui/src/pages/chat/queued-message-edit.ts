// Control UI chat module owns editing a queued message in its queue row.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { chatQueueOrderKey, isMovableChatQueueItem } from "../../lib/chat/chat-queue-order.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import { storageTargetForGateway } from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  anyChatOutboxPaneMatches,
  isDurableQueuedMessage,
  readQueuedMessageById,
  removeVisibleOrScopedQueuedMessageWithoutReleasing,
  type ChatQueueScopedSessionHost,
} from "./chat-queue.ts";
import { storedChatOutboxScopeKey } from "./composer-persistence.ts";

/**
 * The edited row stays in the queue, holding its own place, so the operator can
 * see where the message will land. This records the row-local draft, the outbox
 * scope that owns the row, the payloads that row still owns, and the position
 * the replacement inherits.
 */
export type QueuedMessageEdit = {
  readonly agentId?: string;
  readonly gatewayOwner: string;
  readonly recoveryScope?: string;
  attachments: readonly ChatAttachment[];
  draftText: string;
  id: string;
  orderKey: number;
  revision: number;
  replyToId?: string;
  readonly sessionKey: string;
  source: ChatQueueItem;
  sourceWasDurable: boolean;
};

type QueuedMessageEditHost = ChatQueueScopedSessionHost & {
  client?: Pick<GatewayBrowserClient, "recoveryScope" | "recoveryScopeReady"> | null;
  connected?: boolean;
  chatQueuedEdit?: QueuedMessageEdit | null;
};

function currentQueuedMessageEditOwner(host: QueuedMessageEditHost) {
  // Recovery resolves after hello. While offline, the client retains its last
  // authenticated scope; a replacement client must establish its own scope.
  if (host.connected && host.client && !host.client.recoveryScopeReady) {
    return null;
  }
  return {
    ...resolveUiConversationIdentity(host, host.sessionKey),
    gatewayOwner: storageTargetForGateway(host.settings?.gatewayUrl).gatewayOwner,
    recoveryScope: host.client?.recoveryScope?.trim() || undefined,
  };
}

/** Closed outcomes so the page owns the operator-visible wording. */
type QueuedMessageEditResult = "started" | "unavailable";

export const QUEUED_MESSAGE_EDIT_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before editing it here.";
export const QUEUED_MESSAGE_REMOVAL_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before removing it.";
export const QUEUED_MESSAGE_REORDER_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before reordering it.";
export const QUEUED_MESSAGE_RETRY_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before retrying it.";
export const QUEUED_MESSAGE_STEER_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before steering it.";

/** Captured destinations and recovery owners never follow live alias/default changes. */
export function activeQueuedMessageEdit(host: QueuedMessageEditHost): QueuedMessageEdit | null {
  const edit = host.chatQueuedEdit;
  const owner = currentQueuedMessageEditOwner(host);
  if (
    !edit ||
    !owner ||
    edit.gatewayOwner !== owner.gatewayOwner ||
    edit.recoveryScope !== owner.recoveryScope ||
    storedChatOutboxScopeKey(edit) !== storedChatOutboxScopeKey(owner)
  ) {
    return null;
  }
  // Custody outlives a source-version conflict. Admission checks the captured
  // version; reading/rendering the correction must never discard unsaved text.
  return edit;
}

/**
 * True while any pane is editing the row. The composer that owns an edit is
 * pane-local, but the outbox and the drain are shared and either pane can own the
 * drain lane, so a hold that only its own pane could see would let the other one
 * deliver the text an operator is visibly rewriting.
 */
export function isQueuedMessageBeingEdited(host: QueuedMessageEditHost, id: string): boolean {
  // Credentials fence edit actions, but a pane still on the captured conversation
  // holds its source against a peer drain until the correction is released.
  const gatewayOwner = storageTargetForGateway(host.settings?.gatewayUrl).gatewayOwner;
  return anyChatOutboxPaneMatches(
    host,
    (pane) =>
      pane.chatQueuedEdit?.id === id &&
      pane.chatQueuedEdit.gatewayOwner === gatewayOwner &&
      storedChatOutboxScopeKey(pane.chatQueuedEdit) ===
        storedChatOutboxScopeKey(resolveUiConversationIdentity(pane, pane.sessionKey)),
  );
}

export function beginQueuedMessageEdit(
  host: QueuedMessageEditHost,
  id: string,
): QueuedMessageEditResult {
  const owner = currentQueuedMessageEditOwner(host);
  const item = readQueuedMessageById(host, id);
  // Local slash commands take a different enqueue path that cannot carry a
  // resumed position, so they keep the discard-and-retype flow for now.
  if (
    !owner ||
    !item ||
    !isMovableChatQueueItem(item) ||
    Boolean(item.attachmentStorageError) ||
    Boolean(item.attachments?.some((attachment) => !getChatAttachmentDataUrl(attachment))) ||
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
  host.chatQueuedEdit = {
    ...owner,
    attachments: item.attachments ?? [],
    draftText: item.text,
    id,
    orderKey: chatQueueOrderKey(item),
    revision: 0,
    ...(item.replyToId ? { replyToId: item.replyToId } : {}),
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
  if (!edit) {
    return;
  }
  if (!admittedDurably) {
    const source = readQueuedMessageById(host, edit.id);
    if (
      edit.sourceWasDurable ||
      isDurableQueuedMessage(host, edit.id) ||
      !source ||
      !sameQueuedDeliveryVersion(source, edit.source)
    ) {
      return;
    }
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
