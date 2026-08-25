import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { showToast, type ToastOptions } from "../../lib/toast.ts";
import { releaseChatAttachmentPayload } from "./attachment-payload-store.ts";
import { canAdmitBrowserAnnotation } from "./browser-annotation-admission.ts";

type BrowserAnnotationRemovalHost = {
  getOwner: () => object | undefined;
  getSessionKey: () => string;
  getAttachments: () => ChatAttachment[];
  setAttachments: (attachments: ChatAttachment[]) => void;
  requestUpdate: () => void;
  focusComposer: () => void;
  focusRestoredAnnotation: (attachmentId: string) => void;
};

type BrowserAnnotationRemovalDependencies = {
  presentToast?: (options: ToastOptions) => boolean;
  releasePayload?: (attachmentId: string) => void;
};

/** Removes one annotation package while the shared toast owns its bounded Undo lifetime. */
export function removeBrowserAnnotationWithUndo(
  host: BrowserAnnotationRemovalHost,
  attachment: ChatAttachment,
  labels: { removed: string; undo: string; undoUnavailable: string },
  dependencies: BrowserAnnotationRemovalDependencies = {},
): boolean {
  if (!attachment.browserAnnotation) {
    return false;
  }
  const modelContext = attachment.browserAnnotation.modelContext;
  const sourceOwner = host.getOwner();
  const sourceSessionKey = host.getSessionKey();
  const current = host.getAttachments();
  const sourceIndex = current.findIndex((candidate) => candidate.id === attachment.id);
  if (sourceIndex < 0) {
    return false;
  }

  host.setAttachments(current.filter((candidate) => candidate.id !== attachment.id));
  host.requestUpdate();
  host.focusComposer();

  const releasePayload = dependencies.releasePayload ?? releaseChatAttachmentPayload;
  let settled = false;
  const finalizeRemoval = () => {
    if (settled) {
      return;
    }
    settled = true;
    releasePayload(attachment.id);
  };
  const presentToast = dependencies.presentToast ?? showToast;
  const presented = presentToast({
    message: labels.removed,
    variant: "info",
    key: `browser-annotation:${attachment.id}`,
    scope: { kind: "session", sessionKey: sourceSessionKey },
    actionLabel: labels.undo,
    onAction: () => {
      if (settled) {
        return;
      }
      if (host.getOwner() !== sourceOwner || host.getSessionKey() !== sourceSessionKey) {
        finalizeRemoval();
        return;
      }
      const latest = host.getAttachments();
      if (latest.some((candidate) => candidate.id === attachment.id)) {
        settled = true;
        return;
      }
      if (!canAdmitBrowserAnnotation(latest, modelContext)) {
        finalizeRemoval();
        presentToast({
          message: labels.undoUnavailable,
          variant: "danger",
          scope: { kind: "session", sessionKey: sourceSessionKey },
        });
        return;
      }
      settled = true;
      const insertionIndex = Math.min(sourceIndex, latest.length);
      host.setAttachments([
        ...latest.slice(0, insertionIndex),
        attachment,
        ...latest.slice(insertionIndex),
      ]);
      host.requestUpdate();
      host.focusRestoredAnnotation(attachment.id);
    },
    onDismiss: (reason) => {
      if (reason !== "action") {
        finalizeRemoval();
      }
    },
  });
  if (!presented) {
    finalizeRemoval();
  }
  return true;
}
