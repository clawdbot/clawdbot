import type { ChatAttachment, ChatQueueItem, HumanMention } from "../../lib/chat/chat-types.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  captureChatComposerMemoryFallbackOwnership,
  clearChatComposerMemoryFallback,
  ownsChatComposerMemoryFallback,
  retainChatComposerMemoryFallback,
  type ChatComposerMemoryFallbackOwnership,
} from "./chat-composer-memory-fallback.ts";
import {
  excludeComposerAttachments,
  removeVisibleOrScopedQueuedMessageWithoutReleasing,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resetChatInputHistoryNavigation } from "./input-history.ts";

function attachmentSubmitSignature(attachment: ChatAttachment): string {
  const dataUrl = getChatAttachmentDataUrl(attachment);
  return JSON.stringify([
    attachment.id,
    attachment.mimeType,
    attachment.fileName ?? "",
    attachment.sizeBytes ?? 0,
    dataUrl?.length ?? 0,
    dataUrl?.slice(0, 64) ?? "",
  ]);
}

export function chatSubmitKey(
  host: ChatHost,
  kind: "detached" | "local" | "message" | "queued-edit" | "goal",
  message: string,
  attachments: ChatAttachment[],
  mentions?: readonly HumanMention[],
): string {
  return JSON.stringify([
    kind,
    host.sessionKey,
    message.trim(),
    mentions ?? [],
    attachments.map(attachmentSubmitSignature),
  ]);
}

export function clearSubmittedComposerState(
  host: ChatHost,
  submittedDraft: string,
  submittedAttachments: ChatAttachment[],
  submittedMentions: readonly HumanMention[] | undefined,
  preserveBrowserAnnotations = false,
) {
  const attachmentsUnchanged =
    host.chatAttachments.length === submittedAttachments.length &&
    host.chatAttachments.every(
      (attachment, index) =>
        attachmentSubmitSignature(attachment) ===
        attachmentSubmitSignature(submittedAttachments[index]!),
    );
  if (
    host.chatMessage !== submittedDraft ||
    JSON.stringify(host.chatMentions ?? []) !== JSON.stringify(submittedMentions ?? []) ||
    !attachmentsUnchanged
  ) {
    return {};
  }
  host.chatMessage = "";
  host.chatMentions = [];
  host.chatAttachments = preserveBrowserAnnotations
    ? host.chatAttachments.filter((attachment) => attachment.browserAnnotation)
    : [];
  resetChatInputHistoryNavigation(host);
  return {
    previousAttachments: submittedAttachments,
    previousDraft: submittedDraft,
    previousMentions: submittedMentions,
  };
}

export function snapshotChatAttachments(attachments: readonly ChatAttachment[]): ChatAttachment[] {
  return attachments.map((attachment) => {
    const dataUrl = getChatAttachmentDataUrl(attachment);
    return { ...attachment, ...(dataUrl ? { dataUrl } : {}) };
  });
}

export type ChatCommandComposerRecovery = {
  client: ChatHost["client"];
  composer?: {
    attachments: ChatAttachment[];
    draft: string;
    mentions?: readonly HumanMention[];
    fallbackOwnership?: ChatComposerMemoryFallbackOwnership;
  };
  connectionEpoch: ChatHost["connectionEpoch"];
  scope: StoredChatOutboxScope;
};

function chatCommandRecoveryHost(host: ChatHost): ChatPageHost | undefined {
  return "chatComposerFallbackByScope" in host &&
    typeof host.chatComposerFallbackByScope === "object" &&
    host.chatComposerFallbackByScope !== null
    ? (host as ChatPageHost)
    : undefined;
}

export function captureChatCommandComposerRecovery(
  host: ChatHost,
  scope: StoredChatOutboxScope,
  composer?: { draft: string; mentions?: readonly HumanMention[]; attachments: ChatAttachment[] },
): ChatCommandComposerRecovery {
  const fallbackHost = chatCommandRecoveryHost(host);
  return {
    client: host.client,
    ...(composer
      ? {
          composer: {
            ...composer,
            ...(fallbackHost
              ? {
                  fallbackOwnership: captureChatComposerMemoryFallbackOwnership(
                    fallbackHost,
                    scope,
                    {
                      message: composer.draft,
                      mentions: composer.mentions,
                      attachments: composer.attachments,
                    },
                  ),
                }
              : {}),
          },
        }
      : {}),
    connectionEpoch: host.connectionEpoch,
    scope,
  };
}

export function submittedCommandConnectionIsCurrent(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  return host.client === recovery.client && host.connectionEpoch === recovery.connectionEpoch;
}

export function submittedCommandScopeIsVisible(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  return (
    submittedCommandConnectionIsCurrent(host, recovery) &&
    visibleSessionMatches(host, recovery.scope.sessionKey, recovery.scope.agentId)
  );
}

export function clearOwnedCommandComposerFallback(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  const ownership = recovery.composer?.fallbackOwnership;
  const fallbackHost = chatCommandRecoveryHost(host);
  return fallbackHost ? clearChatComposerMemoryFallback(fallbackHost, ownership) : false;
}

export function commandComposerFallbackRetainsAttachments(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  const ownership = recovery.composer?.fallbackOwnership;
  const fallbackHost = chatCommandRecoveryHost(host);
  return Boolean(
    ownership && fallbackHost && ownsChatComposerMemoryFallback(fallbackHost, ownership),
  );
}

function composerRetainsSubmittedAnnotations(
  host: ChatHost,
  submittedAttachments?: readonly ChatAttachment[],
): boolean {
  const retained = submittedAttachments?.filter((attachment) => attachment.browserAnnotation);
  return Boolean(
    retained?.length &&
    retained.length === host.chatAttachments.length &&
    retained.every(
      (attachment, index) =>
        attachment.id === host.chatAttachments[index]?.id &&
        attachment.browserAnnotation === host.chatAttachments[index]?.browserAnnotation,
    ),
  );
}

export function restoreFailedCommandComposer(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  const composer = recovery.composer;
  if (!composer) {
    return true;
  }
  const fallbackHost = chatCommandRecoveryHost(host);
  if (!submittedCommandConnectionIsCurrent(host, recovery)) {
    return (
      composer.attachments.length === 0 || commandComposerFallbackRetainsAttachments(host, recovery)
    );
  }
  if (!submittedCommandScopeIsVisible(host, recovery)) {
    if (!fallbackHost) {
      return composer.attachments.length === 0;
    }
    const ownership = retainChatComposerMemoryFallback(fallbackHost, recovery.scope, {
      message: composer.draft,
      mentions: composer.mentions,
      attachments: composer.attachments,
    });
    composer.fallbackOwnership = ownership;
    return composer.attachments.length === 0 || ownership !== undefined;
  }
  if (
    host.chatAttachments.length > 0 &&
    !composerRetainsSubmittedAnnotations(host, composer.attachments)
  ) {
    clearOwnedCommandComposerFallback(host, recovery);
    return composer.attachments.length === 0;
  }
  const restorePlan = pendingComposerRestorePlan(host, {
    previousAttachments: composer.attachments,
    previousDraft: composer.draft,
    previousMentions: composer.mentions,
  });
  if (restorePlan.willRestoreDraft) {
    host.chatMessage = composer.draft;
    host.chatMentions = composer.mentions ?? [];
  }
  if (restorePlan.willRestoreAttachments) {
    host.chatAttachments = composer.attachments;
  }
  const retained = composer.attachments.length === 0 || restorePlan.willRestoreAttachments;
  if (!restorePlan.complete) {
    clearOwnedCommandComposerFallback(host, recovery);
  }
  return retained;
}

type PendingComposerSnapshot = {
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
  previousMentions?: readonly HumanMention[];
};

function strictComposerRestore(host: ChatHost, snapshot: PendingComposerSnapshot) {
  // An attachment-only edit is still a newer draft. Restoring old text beside it
  // would combine sends; annotations retained by this exact command are not edits.
  const composerBlank =
    !host.chatMessage.trim() &&
    (host.chatAttachments.length === 0 ||
      composerRetainsSubmittedAnnotations(host, snapshot.previousAttachments));
  const attachments = Boolean(snapshot.previousAttachments?.length && composerBlank);
  return { attachments, draft: snapshot.previousDraft != null && composerBlank };
}

export function cancelChatDelivery(
  host: ChatHost,
  item: ChatQueueItem,
  snapshot: PendingComposerSnapshot,
): void {
  const removed = removeVisibleOrScopedQueuedMessageWithoutReleasing(
    host,
    item.id,
    item.sessionKey,
  );
  const plan = removed ? strictComposerRestore(host, snapshot) : null;
  if (plan?.draft) {
    host.chatMessage = snapshot.previousDraft ?? "";
    host.chatMentions = snapshot.previousMentions ?? [];
  }
  if (plan?.attachments) {
    host.chatAttachments = snapshot.previousAttachments ?? [];
  }
  if (removed && !plan?.attachments) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
}

export function canRestoreComposer(host: ChatHost, snapshot?: PendingComposerSnapshot): boolean {
  const plan = strictComposerRestore(host, snapshot ?? {});
  return (
    (snapshot?.previousDraft !== undefined || snapshot?.previousAttachments !== undefined) &&
    (!snapshot.previousDraft?.trim() || plan.draft) &&
    (!snapshot.previousAttachments?.length || plan.attachments)
  );
}

function pendingComposerRestorePlan(host: ChatHost, snapshot: PendingComposerSnapshot) {
  const willRestoreDraft = snapshot.previousDraft != null && !host.chatMessage.trim();
  const willRestoreAttachments = Boolean(
    snapshot.previousAttachments?.length &&
    (host.chatAttachments.length === 0 ||
      composerRetainsSubmittedAnnotations(host, snapshot.previousAttachments)) &&
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
