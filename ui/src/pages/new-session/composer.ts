import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  handleChatAttachmentDrop,
  handleChatAttachmentPaste,
  isEditableDropTarget,
  isFileDrag,
  renderAttachmentPreview,
  renderChatAttachmentInputs,
  renderChatAttachmentMenu,
} from "../chat/components/chat-attachments.ts";
import type { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import type { NewSessionModelControl } from "./model-control.ts";

type NewSessionComposerOptions = {
  attachments: ChatAttachment[];
  canSubmit: boolean;
  getAttachments: () => ChatAttachment[];
  message: string;
  modelControl?: TemplateResult | typeof nothing;
  pendingAttachmentReads: number;
  readSignal: AbortSignal;
  requiresModifier: boolean;
  submitting: boolean;
  messageLocked?: boolean;
  incognito?: boolean;
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onPendingReadsChange: (delta: 1 | -1) => void;
  onInput: (message: string) => void;
  onToggleIncognito?: () => void;
  onSubmit: () => void;
};

export function renderDraftError(message: string) {
  return html`
    <div class="callout danger new-session-page__error new-session-page__alert" role="alert">
      <span class="new-session-page__alert-icon" aria-hidden="true">${icons.alertTriangle}</span>
      <span class="callout__content new-session-page__alert-message">${message}</span>
    </div>
  `;
}

function handleComposerKeydown(event: KeyboardEvent, options: NewSessionComposerOptions) {
  if (
    options.submitting ||
    event.key !== "Enter" ||
    event.shiftKey ||
    event.isComposing ||
    event.keyCode === 229
  ) {
    return;
  }
  if (!options.requiresModifier || event.metaKey || event.ctrlKey) {
    event.preventDefault();
    options.onSubmit();
  }
}

/** Draft message box styled as the chat composer shell so both pickers match. */
function renderNewSessionComposer(options: NewSessionComposerOptions) {
  const startLabel = options.submitting ? t("newSession.starting") : t("newSession.start");
  const attachmentProps = {
    attachments: options.attachments,
    disabled: options.submitting || options.messageLocked,
    getAttachments: options.getAttachments,
    draft: options.message,
    getDraft: () => options.message,
    onAttachmentsChange: options.onAttachmentsChange,
    onDraftChange: options.onInput,
    onPendingReadsChange: options.onPendingReadsChange,
    readSignal: options.readSignal,
  };
  const enabled = !options.submitting && !options.messageLocked;
  // Nested dragenter/dragleave events must stay balanced so crossing composer
  // children does not flicker the file drop affordance.
  let attachmentDragDepth = 0;
  const setAttachmentDropActive = (event: DragEvent, active: boolean) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (active) {
      if (!enabled || !isFileDrag(event.dataTransfer)) {
        return;
      }
      attachmentDragDepth += 1;
    } else {
      attachmentDragDepth = Math.max(0, attachmentDragDepth - 1);
    }
    target.toggleAttribute("data-attachment-drop-active", attachmentDragDepth > 0);
  };
  const clearAttachmentDropActive = (event: DragEvent) => {
    attachmentDragDepth = 0;
    const target = event.currentTarget;
    if (target instanceof HTMLElement) {
      target.removeAttribute("data-attachment-drop-active");
    }
  };
  return html`
    <div
      class="agent-chat__composer-shell new-session-page__composer"
      @drop=${(event: DragEvent) => {
        // Text/URL drops stay native only inside the textarea; elsewhere they
        // are cancelled so a dropped link cannot navigate the app away. File
        // drops are cancelled even while disabled for the same reason.
        if (!isFileDrag(event.dataTransfer)) {
          if (!isEditableDropTarget(event)) {
            event.preventDefault();
          }
          return;
        }
        event.preventDefault();
        clearAttachmentDropActive(event);
        if (enabled) {
          handleChatAttachmentDrop(event, attachmentProps);
        }
      }}
      @dragenter=${(event: DragEvent) => setAttachmentDropActive(event, true)}
      @dragleave=${(event: DragEvent) => setAttachmentDropActive(event, false)}
      @dragover=${(event: DragEvent) => {
        if (!isFileDrag(event.dataTransfer)) {
          if (!isEditableDropTarget(event)) {
            event.preventDefault();
            if (event.dataTransfer) {
              event.dataTransfer.dropEffect = "none";
            }
          }
          return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = enabled ? "copy" : "none";
        }
      }}
    >
      <div class="agent-chat__input">
        ${renderChatAttachmentInputs(attachmentProps)} ${renderAttachmentPreview(attachmentProps)}
        <div class="agent-chat__composer-input-row">
          ${renderChatAttachmentMenu(attachmentProps)}
          <div class="agent-chat__composer-combobox">
            <textarea
              class="new-session-page__message"
              rows="1"
              ?disabled=${options.submitting || options.messageLocked}
              placeholder=${t("newSession.messagePlaceholder")}
              .value=${options.message}
              @input=${(event: Event) =>
                options.onInput((event.target as HTMLTextAreaElement).value)}
              @keydown=${(event: KeyboardEvent) => handleComposerKeydown(event, options)}
              @paste=${(event: ClipboardEvent) => {
                if (!options.submitting && !options.messageLocked) {
                  handleChatAttachmentPaste(event, attachmentProps);
                }
              }}
            ></textarea>
          </div>
          <div class="agent-chat__composer-actions">
            <openclaw-tooltip content=${t("newSession.start")}>
              <button
                type="button"
                class="chat-send-btn"
                ?disabled=${!options.canSubmit}
                aria-label=${startLabel}
                @click=${options.onSubmit}
              >
                ${options.submitting ? icons.loader : icons.arrowUp}
              </button>
            </openclaw-tooltip>
          </div>
        </div>
        <div class="agent-chat__composer-footer">
          <div class="agent-chat__composer-controls">
            ${options.modelControl && options.modelControl !== nothing
              ? html`<div class="chat-composer-model-control">${options.modelControl}</div>`
              : nothing}
            <button
              type="button"
              class="new-session-page__incognito ${options.incognito
                ? "new-session-page__incognito--active"
                : ""}"
              role="switch"
              aria-checked=${String(options.incognito === true)}
              ?disabled=${options.submitting || options.messageLocked}
              title=${t("newSession.incognitoDescription")}
              @click=${() => options.onToggleIncognito?.()}
            >
              <span aria-hidden="true">${icons.lock}</span>${t("newSession.incognito")}
            </button>
          </div>
        </div>
        ${options.pendingAttachmentReads > 0
          ? html`<span class="agent-chat__sr-only" role="status"
              >${t("newSession.readingAttachment")}</span
            >`
          : nothing}
      </div>
    </div>
  `;
}

export function renderNewSessionDraftComposer(options: {
  agent?: import("../../api/types.ts").GatewayAgentRow;
  agentId: string;
  attachmentDraft: NewSessionAttachmentDraft;
  canSubmit: boolean;
  context: import("../../app/context.ts").ApplicationContext | undefined;
  isCatalogTarget: boolean;
  message: string;
  incognito?: boolean;
  modelControl: NewSessionModelControl;
  requiresModifier: boolean;
  submitting: boolean;
  messageLocked?: boolean;
  onInput: (message: string) => void;
  onToggleIncognito?: () => void;
  onSubmit: () => void;
}) {
  const readSignal = options.attachmentDraft.readSignal;
  return renderNewSessionComposer({
    attachments: options.attachmentDraft.attachments,
    canSubmit: options.canSubmit,
    getAttachments: () => options.attachmentDraft.attachments,
    message: options.message,
    incognito: options.incognito,
    modelControl: options.isCatalogTarget
      ? nothing
      : options.modelControl.render({
          agent: options.agent,
          agentId: options.agentId,
          context: options.context,
          sending: options.submitting,
        }),
    pendingAttachmentReads: options.attachmentDraft.pendingReads,
    readSignal,
    requiresModifier: options.requiresModifier,
    submitting: options.submitting,
    messageLocked: options.messageLocked,
    onAttachmentsChange: (attachments) => {
      if (!options.submitting && !options.messageLocked) {
        options.attachmentDraft.replace(attachments);
      }
    },
    onPendingReadsChange: (delta) => options.attachmentDraft.updatePending(readSignal, delta),
    onInput: options.onInput,
    onToggleIncognito: options.onToggleIncognito,
    onSubmit: options.onSubmit,
  });
}
