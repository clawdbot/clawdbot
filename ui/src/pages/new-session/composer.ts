import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  handleChatAttachmentPaste,
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
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onPendingReadsChange: (delta: 1 | -1) => void;
  onInput: (message: string) => void;
  onSubmit: () => void;
};

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
  return html`
    <div class="agent-chat__composer-shell new-session-page__composer">
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
        ${options.modelControl && options.modelControl !== nothing
          ? html`<div class="agent-chat__composer-footer">
              <div class="agent-chat__composer-controls">
                <div class="chat-composer-model-control">${options.modelControl}</div>
              </div>
            </div>`
          : nothing}
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
  agentDefaultModel?: string;
  agentId: string;
  attachmentDraft: NewSessionAttachmentDraft;
  canSubmit: boolean;
  context: import("../../app/context.ts").ApplicationContext | undefined;
  isCatalogTarget: boolean;
  message: string;
  modelControl: NewSessionModelControl;
  requiresModifier: boolean;
  submitting: boolean;
  messageLocked?: boolean;
  onInput: (message: string) => void;
  onSubmit: () => void;
}) {
  const readSignal = options.attachmentDraft.readSignal;
  return renderNewSessionComposer({
    attachments: options.attachmentDraft.attachments,
    canSubmit: options.canSubmit,
    getAttachments: () => options.attachmentDraft.attachments,
    message: options.message,
    modelControl: options.isCatalogTarget
      ? nothing
      : options.modelControl.render({
          agentDefaultModel: options.agentDefaultModel,
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
    onSubmit: options.onSubmit,
  });
}
