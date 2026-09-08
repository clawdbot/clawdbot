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
import { excludeComposerAttachments, removeQueuedMessageWithoutReleasing } from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { chatAttachmentDraftSignature } from "./durable-composer-persistence.ts";
import { resetChatInputHistoryNavigation } from "./input-history.ts";

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
    chatAttachmentDraftSignature(message.trim(), attachments, undefined, mentions),
  ]);
}

export function clearSubmittedComposerState(
  host: ChatHost,
  submittedDraft: string,
  submittedAttachments: ChatAttachment[],
  submittedMentions: readonly HumanMention[] | undefined,
  preserveBrowserAnnotations = false,
) {
  if (
    chatAttachmentDraftSignature(
      host.chatMessage,
      host.chatAttachments,
      undefined,
      host.chatMentions,
    ) !==
    chatAttachmentDraftSignature(submittedDraft, submittedAttachments, undefined, submittedMentions)
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
  const restorePlan = strictComposerRestore(host, {
    previousAttachments: composer.attachments,
    previousDraft: composer.draft,
    previousMentions: composer.mentions,
  });
  if (restorePlan.draft) {
    host.chatMessage = composer.draft;
    host.chatMentions = composer.mentions ?? [];
  }
  if (restorePlan.attachments) {
    host.chatAttachments = composer.attachments;
  }
  const retained = composer.attachments.length === 0 || restorePlan.attachments;
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
  const draft = snapshot.previousDraft != null && composerBlank;
  return {
    attachments,
    draft,
    complete:
      (!snapshot.previousDraft?.trim() || draft) &&
      (!snapshot.previousAttachments?.length || attachments),
  };
}

export function cancelChatDelivery(
  host: ChatHost,
  item: ChatQueueItem,
  snapshot: PendingComposerSnapshot,
): boolean {
  const plan = strictComposerRestore(host, snapshot);
  const removed = removeQueuedMessageWithoutReleasing(host, item.id);
  if (!removed) {
    return false;
  }
  if (plan.draft) {
    host.chatMessage = snapshot.previousDraft ?? "";
    host.chatMentions = snapshot.previousMentions ?? [];
  }
  if (plan.attachments) {
    host.chatAttachments = snapshot.previousAttachments ?? [];
  }
  if (!plan.attachments) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
  return true;
}

export function restoreRejectedChatDelivery(
  host: ChatHost,
  item: ChatQueueItem,
  snapshot: PendingComposerSnapshot = {},
): boolean {
  const plan = strictComposerRestore(host, snapshot);
  // A detached or relinquished pane can finish delivery, but no longer owns its
  // composer. Keep the outbox row until that owner can accept the whole draft.
  return (
    host.canRestoreComposer?.() === true &&
    visibleSessionMatches(host, item.sessionKey ?? host.sessionKey, item.agentId) &&
    (snapshot.previousDraft !== undefined || snapshot.previousAttachments !== undefined) &&
    plan.complete &&
    cancelChatDelivery(host, item, snapshot)
  );
}
