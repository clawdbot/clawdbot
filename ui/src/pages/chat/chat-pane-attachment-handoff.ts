import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  releaseChatAttachmentPayload,
  releaseDisplacedChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveStoredChatOutboxScope, storedChatOutboxScopeKey } from "./composer-persistence.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import { panesOf, visiblePanesOf } from "./split-layout.ts";

export type ChatAttachmentGatewayOwner = ApplicationContext["gateway"]["snapshot"]["client"];

function handoffKey(paneId: string, state: ChatPageHost, owner: ChatAttachmentGatewayOwner) {
  return {
    owner,
    paneId,
    scopeKey: storedChatOutboxScopeKey(resolveStoredChatOutboxScope(state, state.sessionKey)),
  };
}

function releaseAttachments(
  attachments: readonly ChatAttachment[],
  retainedIds = new Set<string>(),
  releasedIds = new Set<string>(),
): void {
  for (const attachment of attachments) {
    if (retainedIds.has(attachment.id) || releasedIds.has(attachment.id)) {
      continue;
    }
    releasedIds.add(attachment.id);
    releaseChatAttachmentPayload(attachment.id);
  }
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
  if (restored.owner !== owner) {
    const retainPlain = (attachments: readonly ChatAttachment[]) => {
      const retained = attachments.filter((attachment) => !attachment.browserAnnotation);
      releaseDisplacedChatAttachmentPayloads(attachments, [retained]);
      return retained;
    };
    restored.attachments = retainPlain(restored.attachments);
    for (const fallback of Object.values(restored.fallbacks)) {
      fallback.attachments = retainPlain(fallback.attachments);
    }
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
  const releasedIds = new Set<string>();
  releaseAttachments(state.chatAttachments, new Set(), releasedIds);
  for (const fallback of Object.values(state.chatComposerFallbackByScope)) {
    releaseAttachments(fallback.attachments, new Set(), releasedIds);
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
    const preservePlain = !previousOwner || previousOwner.gatewayUrl === nextOwner.gatewayUrl;
    const retainPlain = (attachments: readonly ChatAttachment[]) => {
      const retained = preservePlain
        ? attachments.filter((attachment) => !attachment.browserAnnotation)
        : [];
      releaseDisplacedChatAttachmentPayloads(attachments, [retained]);
      return retained;
    };
    state.chatAttachments = retainPlain(state.chatAttachments);
    for (const fallback of Object.values(state.chatComposerFallbackByScope)) {
      fallback.attachments = retainPlain(fallback.attachments);
    }
    state.requestUpdate?.();
  }
  if (previousOwner && previousOwner.gatewayUrl !== nextOwner.gatewayUrl) {
    context.chatAttachmentHandoff.clearPane(paneId);
  }
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
