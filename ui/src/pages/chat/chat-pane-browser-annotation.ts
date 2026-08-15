import type {
  BrowserAnnotationDraft,
  BrowserAnnotationEvent,
} from "../../components/browser/browser-annotation.ts";
import { canAdmitBrowserAnnotation } from "./browser-annotation-admission.ts";
import { CHAT_COMPOSER_TEXTAREA_SELECTOR } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { chatAttachmentFromDataUrl } from "./components/chat-attachments.ts";

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
  const attachment = chatAttachmentFromDataUrl(
    detail.dataUrl,
    detail.fileName || "annotation",
    state.hello?.policy?.attachments,
  );
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
