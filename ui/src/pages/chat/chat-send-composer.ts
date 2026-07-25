import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  excludeComposerAttachments,
  removeVisibleOrScopedQueuedMessageWithoutReleasing,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";

export function restoreComposerAfterFailedSend(
  host: ChatHost,
  opts: {
    previousAttachments?: ChatAttachment[];
    previousDraft?: string;
  },
) {
  if (opts.previousDraft != null && !host.chatMessage.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (opts.previousAttachments?.length && host.chatAttachments.length === 0) {
    host.chatAttachments = opts.previousAttachments;
  }
}

type PendingComposerSnapshot = {
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
};

export function pendingComposerRestorePlan(host: ChatHost, snapshot: PendingComposerSnapshot) {
  const willRestoreDraft = snapshot.previousDraft != null && !host.chatMessage.trim();
  const willRestoreAttachments = Boolean(
    snapshot.previousAttachments?.length &&
    host.chatAttachments.length === 0 &&
    (willRestoreDraft || !host.chatMessage.trim()),
  );
  return {
    complete:
      (!snapshot.previousDraft?.trim() || willRestoreDraft) &&
      (!snapshot.previousAttachments?.length || willRestoreAttachments),
    willRestoreAttachments,
    willRestoreDraft,
  };
}

export function cancelPendingSendBeforeRequest(
  host: ChatHost,
  queued: ChatQueueItem,
  opts: PendingComposerSnapshot & {
    restoreComposer?: boolean;
  },
) {
  const removed = removeVisibleOrScopedQueuedMessageWithoutReleasing(
    host,
    queued.id,
    queued.sessionKey,
  );
  const restoreComposer = opts.restoreComposer !== false && removed != null;
  const restorePlan = pendingComposerRestorePlan(host, opts);
  const willRestoreDraft = restoreComposer && restorePlan.willRestoreDraft;
  const willRestoreAttachments = restoreComposer && restorePlan.willRestoreAttachments;
  if (restoreComposer) {
    if (willRestoreDraft) {
      host.chatMessage = opts.previousDraft ?? "";
    }
    if (willRestoreAttachments) {
      host.chatAttachments = opts.previousAttachments ?? [];
    }
  }
  if (removed && !willRestoreAttachments) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
}
