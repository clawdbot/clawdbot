import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { removeBrowserAnnotationsWithUndo } from "./browser-annotation-removal.ts";
import { ChatPaneHeader } from "./chat-pane-header.ts";
import { CHAT_COMPOSER_TEXTAREA_SELECTOR } from "./chat-pane-shared.ts";

export abstract class ChatPaneBrowserAnnotationRender extends ChatPaneHeader {
  protected readonly removeBrowserAnnotations = (attachments: readonly ChatAttachment[]) => {
    const state = this.state;
    if (!state) {
      return;
    }
    const sourceSessionKey = state.sessionKey;
    removeBrowserAnnotationsWithUndo(
      {
        getOwner: () => this.browserAnnotationOwner(),
        getSessionKey: () => this.state?.sessionKey ?? "",
        getAttachments: () => this.state?.chatAttachments ?? [],
        setAttachments: (nextAttachments) => {
          if (this.state) {
            this.state.chatAttachments = nextAttachments;
          }
        },
        requestUpdate: () => this.state?.requestUpdate?.(),
        focusComposer: () => {
          void this.updateComplete.then(() => {
            if (this.state !== state || this.state.sessionKey !== sourceSessionKey) {
              return;
            }
            this.querySelector<HTMLTextAreaElement>(CHAT_COMPOSER_TEXTAREA_SELECTOR)?.focus({
              preventScroll: true,
            });
          });
        },
        focusRestoredAnnotation: (attachmentId) => {
          void this.updateComplete.then(() => {
            if (this.state !== state || this.state.sessionKey !== sourceSessionKey) {
              return;
            }
            const card = [...this.querySelectorAll<HTMLElement>("[data-attachment-id]")].find(
              (candidate) => candidate.dataset.attachmentId === attachmentId,
            );
            card?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
          });
        },
      },
      attachments,
      {
        removed: t("chat.composer.browserAnnotationRemoved"),
        undo: t("common.undo"),
        undoUnavailable: t("chat.composer.browserAnnotationUndoUnavailable"),
      },
    );
  };
}
