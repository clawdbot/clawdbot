import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import {
  releaseChatAttachmentPayloads,
  releaseDisplacedChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { storedChatOutboxScopeKey } from "./composer-persistence.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import { panesOf, visiblePanesOf } from "./split-layout.ts";

export type ChatAttachmentGatewayOwner = ApplicationContext["gateway"]["snapshot"]["client"];

function handoffKey(paneId: string, state: ChatPageHost, owner: ChatAttachmentGatewayOwner) {
  return {
    owner,
    paneId,
    scopeKey: storedChatOutboxScopeKey(resolveUiConversationIdentity(state, state.sessionKey)),
  };
}

export function restorePaneStagedAttachments(
  context: ApplicationContext,
  paneId: string,
  state: ChatPageHost,
  owner: ChatAttachmentGatewayOwner,
): void {
  const restored = context.chatAttachmentHandoff.consume(handoffKey(paneId, state, owner));
  if (!restored) {
    return;
  }
  const currentIds = new Set(state.chatAttachments.map((attachment) => attachment.id));
  state.chatAttachments = [
    ...state.chatAttachments,
    ...restored.attachments.filter((attachment) => !currentIds.has(attachment.id)),
  ];
  const displaced = Object.entries(restored.fallbacks)
    .filter(([scopeKey]) => Object.hasOwn(state.chatComposerFallbackByScope, scopeKey))
    .flatMap(([, fallback]) => fallback.attachments);
  state.chatComposerFallbackByScope = {
    ...restored.fallbacks,
    ...state.chatComposerFallbackByScope,
  };
  releaseDisplacedChatAttachmentPayloads(displaced, [
    state.chatAttachments,
    ...Object.values(state.chatComposerFallbackByScope).map((fallback) => fallback.attachments),
  ]);
}

export function preparePaneStagedAttachments(
  context: ApplicationContext,
  paneId: string,
  state: ChatPageHost,
  owner: ChatAttachmentGatewayOwner,
): void {
  const attachments = [...state.chatAttachments];
  context.chatAttachmentHandoff.prepare({
    ...handoffKey(paneId, state, owner),
    attachments,
    fallbacks: state.chatComposerFallbackByScope,
  });
}

export function discardStateStagedAttachments(state: ChatPageHost | undefined): void {
  if (!state) {
    return;
  }
  releaseChatAttachmentPayloads(state.chatAttachments);
  for (const fallback of Object.values(state.chatComposerFallbackByScope)) {
    releaseChatAttachmentPayloads(fallback.attachments);
    fallback.attachments = [];
  }
  state.chatAttachments = [];
}

export function replacePaneStagedAttachmentGatewayOwner(
  context: ApplicationContext,
  paneId: string,
  state: ChatPageHost | undefined,
  previousOwner: ChatAttachmentGatewayOwner,
  nextOwner: ChatAttachmentGatewayOwner,
): ChatAttachmentGatewayOwner {
  if (!nextOwner || previousOwner === nextOwner) {
    return previousOwner;
  }
  // Rotating the client invalidates annotation Undo context owned by the old
  // client, but plain file/image payloads are client-local data URLs — a gap
  // reconnect or plugin-install rotation must not silently discard them.
  if (state) {
    const dropAnnotations = (attachments: readonly ChatAttachment[]) => {
      releaseChatAttachmentPayloads(
        attachments.filter((attachment) => attachment.browserAnnotation),
      );
      return attachments.filter((attachment) => !attachment.browserAnnotation);
    };
    state.chatAttachments = dropAnnotations(state.chatAttachments);
    for (const fallback of Object.values(state.chatComposerFallbackByScope)) {
      fallback.attachments = dropAnnotations(fallback.attachments);
    }
    state.requestUpdate?.();
  }
  context.chatAttachmentHandoff.clearPane(paneId);
  return nextOwner;
}

type StagedAttachmentPane = Element & {
  paneId: string;
  sessionKey: string;
  discardStagedAttachments?: () => void;
  resumeStagedAttachments?: () => void;
};

export function resumeStagedPanes(
  root: ParentNode,
  layout: ChatSplitLayout,
  narrow: boolean,
): void {
  const visiblePaneIds = new Set(visiblePanesOf(layout, narrow).map((pane) => pane.id));
  for (const pane of root.querySelectorAll<StagedAttachmentPane>("openclaw-chat-pane")) {
    if (visiblePaneIds.has(pane.paneId)) {
      pane.resumeStagedAttachments?.();
    }
  }
}

export function closeStagedPane(
  context: ApplicationContext,
  root: ParentNode,
  layout: ChatSplitLayout,
  paneId: string,
) {
  const survivingPane = panesOf(layout).find((candidate) => candidate.id !== paneId);
  const mounted = [...root.querySelectorAll<StagedAttachmentPane>("openclaw-chat-pane")].filter(
    (candidate) => candidate.paneId === paneId,
  );
  // Clear every retained presentation first so their disconnects cannot
  // restage a package under a later reused logical pane id.
  for (const pane of mounted) {
    pane.discardStagedAttachments?.();
  }
  context.chatAttachmentHandoff.clearPane(paneId);
  return survivingPane;
}
