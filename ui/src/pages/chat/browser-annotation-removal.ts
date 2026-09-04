import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { showToast, type ToastOptions } from "../../lib/toast.ts";
import { releaseChatAttachmentPayload } from "./attachment-payload-store.ts";
import { canAdmitBrowserAnnotations } from "./browser-annotation-admission.ts";

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

/** Removes annotation packages while one shared toast owns their bounded Undo lifetime. */
export function removeBrowserAnnotationsWithUndo(
  host: BrowserAnnotationRemovalHost,
  attachments: readonly ChatAttachment[],
  labels: { removed: string; undo: string; undoUnavailable: string },
  dependencies: BrowserAnnotationRemovalDependencies = {},
): boolean {
  const modelContexts = attachments.flatMap((attachment) =>
    attachment.browserAnnotation ? [attachment.browserAnnotation.modelContext] : [],
  );
  if (attachments.length === 0 || modelContexts.length !== attachments.length) {
    return false;
  }
  const ids = new Set(attachments.map((attachment) => attachment.id));
  if (ids.size !== attachments.length) {
    return false;
  }
  const sourceOwner = host.getOwner();
  const sourceSessionKey = host.getSessionKey();
  const current = host.getAttachments();
  const sourceEntries = attachments
    .map((attachment) => ({
      attachment,
      index: current.findIndex((candidate) => candidate.id === attachment.id),
    }))
    .toSorted((left, right) => left.index - right.index);
  const firstEntry = sourceEntries[0];
  if (!firstEntry || sourceEntries.some((entry) => entry.index < 0)) {
    return false;
  }

  host.setAttachments(current.filter((candidate) => !ids.has(candidate.id)));
  host.requestUpdate();
  host.focusComposer();

  const releasePayload = dependencies.releasePayload ?? releaseChatAttachmentPayload;
  let settled = false;
  const finalizeRemoval = () => {
    if (settled) {
      return;
    }
    settled = true;
    for (const attachment of attachments) {
      releasePayload(attachment.id);
    }
  };
  const presentToast = dependencies.presentToast ?? showToast;
  const presented = presentToast({
    message: labels.removed,
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
      if (latest.some((candidate) => ids.has(candidate.id))) {
        settled = true;
        for (const attachment of attachments) {
          if (!latest.some((candidate) => candidate.id === attachment.id)) {
            releasePayload(attachment.id);
          }
        }
        return;
      }
      if (!canAdmitBrowserAnnotations(latest, modelContexts)) {
        finalizeRemoval();
        presentToast({ message: labels.undoUnavailable });
        return;
      }
      settled = true;
      const restored = [...latest];
      for (const entry of sourceEntries) {
        restored.splice(Math.min(entry.index, restored.length), 0, entry.attachment);
      }
      host.setAttachments(restored);
      host.requestUpdate();
      host.focusRestoredAnnotation(firstEntry.attachment.id);
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
