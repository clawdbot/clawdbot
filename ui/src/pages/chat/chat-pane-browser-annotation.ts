import type { ApplicationContext } from "../../app/context.ts";
import type {
  BrowserAnnotationDraft,
  BrowserAnnotationEvent,
} from "../../components/browser/browser-annotation.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayload } from "./attachment-payload-store.ts";
import { canAdmitBrowserAnnotation } from "./browser-annotation-admission.ts";
import { CHAT_COMPOSER_TEXTAREA_SELECTOR } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { chatAttachmentFromDataUrl } from "./components/chat-attachments.ts";
import { resolveStoredChatOutboxScope, storedChatOutboxScopeKey } from "./composer-persistence.ts";
import { panesOf, type ChatSplitLayout } from "./split-layout.ts";

export type BrowserAnnotationGatewayOwner = ApplicationContext["gateway"]["snapshot"]["client"];

export function focusBrowserAnnotationComposerAfterUpdate(
  host: ParentNode & { updateComplete: Promise<unknown> },
): void {
  void host.updateComplete.then(() => {
    host.querySelector<HTMLTextAreaElement>(CHAT_COMPOSER_TEXTAREA_SELECTOR)?.focus({
      preventScroll: true,
    });
  });
}

/** Adopts one complete browser annotation without mixing generated context into the user's draft. */
export function receiveBrowserAnnotation(
  state: ChatPageHost | null | undefined,
  active: boolean,
  event: Event,
): boolean {
  if (!state || !active || event.defaultPrevented || !(event instanceof CustomEvent)) {
    return false;
  }
  const detail = event.detail as BrowserAnnotationDraft | null;
  if (
    !detail ||
    typeof detail.modelContext !== "string" ||
    typeof detail.dataUrl !== "string" ||
    !detail.card
  ) {
    return false;
  }
  if (!canAdmitBrowserAnnotation(state.chatAttachments, detail.modelContext)) {
    // A rejected capture remains editable in the browser panel for a later retry.
    (event as BrowserAnnotationEvent).rejection = "limit";
    return false;
  }
  const attachment = chatAttachmentFromDataUrl(detail.dataUrl, detail.fileName || "annotation");
  if (!attachment) {
    return false;
  }
  event.preventDefault();
  state.chatAttachments = [
    ...state.chatAttachments,
    {
      ...attachment,
      browserAnnotation: {
        modelContext: detail.modelContext,
        title: detail.card.title,
        displayUrl: detail.card.displayUrl,
        markedRegionCount: detail.card.markedRegionCount,
        inspectedElement: detail.card.inspectedElement,
      },
    },
  ];
  state.requestUpdate?.();
  return true;
}

/** Releases only annotation-owned payloads when a pane's state is discarded. */
function releasePaneBrowserAnnotations(
  state: ChatPageHost,
  releasePayload = releaseChatAttachmentPayload,
  released = new Set<string>(),
): void {
  const release = (attachments: readonly ChatAttachment[]) => {
    for (const attachment of attachments) {
      if (attachment.browserAnnotation === undefined || released.has(attachment.id)) {
        continue;
      }
      released.add(attachment.id);
      releasePayload(attachment.id);
    }
  };
  release(state.chatAttachments);
  for (const fallback of Object.values(state.chatComposerFallbackByScope)) {
    release(fallback.attachments);
  }
}

function browserAnnotationHandoffKey(
  paneId: string,
  state: ChatPageHost,
  owner: ApplicationContext["gateway"]["snapshot"]["client"],
) {
  return {
    owner,
    paneId,
    scopeKey: storedChatOutboxScopeKey(resolveStoredChatOutboxScope(state, state.sessionKey)),
  };
}

export function restorePaneBrowserAnnotations(
  context: ApplicationContext,
  paneId: string,
  state: ChatPageHost,
  owner: ApplicationContext["gateway"]["snapshot"]["client"],
): void {
  const restored = context.browserAnnotationHandoff.consume(
    browserAnnotationHandoffKey(paneId, state, owner),
  );
  if (!restored) {
    return;
  }
  const currentIds = new Set(state.chatAttachments.map((attachment) => attachment.id));
  state.chatAttachments = [
    ...state.chatAttachments,
    ...restored.filter((attachment) => !currentIds.has(attachment.id)),
  ];
}

export function preparePaneBrowserAnnotations(
  context: ApplicationContext,
  paneId: string,
  state: ChatPageHost,
  owner: ApplicationContext["gateway"]["snapshot"]["client"],
): void {
  const annotations = state.chatAttachments.filter(
    (attachment) => attachment.browserAnnotation !== undefined,
  );
  context.browserAnnotationHandoff.prepare({
    ...browserAnnotationHandoffKey(paneId, state, owner),
    attachments: annotations,
  });
  // Memory fallbacks are pane-local. Only the mounted scope transfers; stale
  // fallback annotations must release when their pane owner disappears.
  releasePaneBrowserAnnotations(
    state,
    releaseChatAttachmentPayload,
    new Set(annotations.map((attachment) => attachment.id)),
  );
}

export function discardStateBrowserAnnotations(state: ChatPageHost | undefined): void {
  if (!state) {
    return;
  }
  releasePaneBrowserAnnotations(state);
  state.chatAttachments = state.chatAttachments.filter(
    (attachment) => attachment.browserAnnotation === undefined,
  );
  for (const fallback of Object.values(state.chatComposerFallbackByScope)) {
    fallback.attachments = fallback.attachments.filter(
      (attachment) => attachment.browserAnnotation === undefined,
    );
  }
}

export function replacePaneBrowserAnnotationGatewayOwner(
  context: ApplicationContext,
  paneId: string,
  state: ChatPageHost | undefined,
  previousOwner: BrowserAnnotationGatewayOwner,
  nextOwner: BrowserAnnotationGatewayOwner,
): BrowserAnnotationGatewayOwner {
  if (!nextOwner || previousOwner === nextOwner) {
    return previousOwner;
  }
  discardStateBrowserAnnotations(state);
  state?.requestUpdate?.();
  context.browserAnnotationHandoff.clearPane(paneId);
  // Rotating the token also invalidates any pending Undo owned by the old client.
  return nextOwner;
}

type BrowserAnnotationPane = Element & {
  paneId: string;
  discardBrowserAnnotations?: () => void;
};

export function closePaneBrowserAnnotations(
  context: ApplicationContext,
  root: ParentNode,
  layout: ChatSplitLayout,
  paneId: string,
) {
  const survivingPane = panesOf(layout).find((candidate) => candidate.id !== paneId);
  const pane = [...root.querySelectorAll<BrowserAnnotationPane>("openclaw-chat-pane")].find(
    (candidate) => candidate.paneId === paneId,
  );
  // Clear a mounted pane first so its disconnect cannot restage the closed annotation.
  pane?.discardBrowserAnnotations?.();
  context.browserAnnotationHandoff.clearPane(paneId);
  return survivingPane;
}
