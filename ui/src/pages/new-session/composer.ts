import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
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
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  scheduleTextareaHeightAdjustment,
} from "../chat/components/chat-composer-dom.ts";
import type { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import type { NewSessionVisibility } from "./create-params.ts";
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
  submitDisabledReason?: string;
  submitting: boolean;
  textareaController: NewSessionComposerTextareaController;
  messageLocked?: boolean;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  incognitoDisabledReason?: string;
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onPendingReadsChange: (delta: 1 | -1) => void;
  onInput: (message: string) => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
};

export class NewSessionComposerTextareaController {
  private textarea: HTMLTextAreaElement | null = null;

  readonly ref = (element?: Element) => {
    const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
    if (this.textarea && this.textarea !== nextTextarea) {
      disconnectTextareaOverflowObserver(this.textarea);
    }
    this.textarea = nextTextarea;
    if (nextTextarea) {
      observeTextareaOverflow(nextTextarea);
      scheduleTextareaHeightAdjustment(nextTextarea);
    }
  };

  syncDraft(message: string) {
    // The stable ref measures attachment only. Programmatic restores and
    // resets still need a post-render measurement after Lit commits .value.
    if (this.textarea?.isConnected && this.textarea.value !== message) {
      scheduleTextareaHeightAdjustment(this.textarea);
    }
  }

  disconnect() {
    if (this.textarea) {
      disconnectTextareaOverflowObserver(this.textarea);
      this.textarea = null;
    }
  }
}

/** Mutually exclusive visibility pills: selecting one clears the other, re-click returns to normal. */
function renderVisibilityPill(params: {
  mode: Exclude<NewSessionVisibility, "normal">;
  icon: unknown;
  label: string;
  description: string;
  disabledReason?: string;
  options: NewSessionComposerOptions;
}) {
  const active = params.options.visibility === params.mode;
  const disabled =
    params.options.submitting || params.options.messageLocked || Boolean(params.disabledReason);
  return html`
    <button
      type="button"
      class="new-session-page__visibility ${active ? "new-session-page__visibility--active" : ""}"
      role="switch"
      aria-checked=${String(active)}
      ?disabled=${disabled}
      title=${params.disabledReason ?? params.description}
      @click=${() => params.options.onVisibilityChange?.(active ? "normal" : params.mode)}
    >
      <span aria-hidden="true">${params.icon}</span>${params.label}
    </button>
  `;
}

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
    !options.canSubmit ||
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
  options.textareaController.syncDraft(options.message);
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
              ${ref(options.textareaController.ref)}
              class="new-session-page__message"
              rows="1"
              ?disabled=${options.submitting || options.messageLocked}
              placeholder=${t("newSession.messagePlaceholder")}
              .value=${options.message}
              @input=${(event: Event) => {
                const target = event.target as HTMLTextAreaElement;
                adjustTextareaHeight(target);
                options.onInput(target.value);
              }}
              @keydown=${(event: KeyboardEvent) => handleComposerKeydown(event, options)}
              @paste=${(event: ClipboardEvent) => {
                if (!options.submitting && !options.messageLocked) {
                  handleChatAttachmentPaste(event, attachmentProps);
                }
              }}
            ></textarea>
          </div>
          <div class="agent-chat__composer-actions">
            <openclaw-tooltip content=${options.submitDisabledReason ?? t("newSession.start")}>
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
            ${options.draftAvailable
              ? renderVisibilityPill({
                  mode: "draft",
                  icon: "👻",
                  label: t("newSession.draft"),
                  description: t("newSession.draftDescription"),
                  options,
                })
              : nothing}
            ${renderVisibilityPill({
              mode: "incognito",
              icon: icons.lock,
              label: t("newSession.incognito"),
              description: t("newSession.incognitoDescription"),
              disabledReason: options.incognitoDisabledReason,
              options,
            })}
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
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  modelControl: NewSessionModelControl;
  textareaController: NewSessionComposerTextareaController;
  requiresModifier: boolean;
  submitDisabledReason?: string;
  submitting: boolean;
  messageLocked?: boolean;
  incognitoDisabledReason?: string;
  onInput: (message: string) => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
}) {
  const readSignal = options.attachmentDraft.readSignal;
  return renderNewSessionComposer({
    attachments: options.attachmentDraft.attachments,
    canSubmit: options.canSubmit,
    getAttachments: () => options.attachmentDraft.attachments,
    message: options.message,
    visibility: options.visibility,
    draftAvailable: options.draftAvailable,
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
    submitDisabledReason: options.submitDisabledReason,
    submitting: options.submitting,
    textareaController: options.textareaController,
    messageLocked: options.messageLocked,
    incognitoDisabledReason: options.incognitoDisabledReason,
    onAttachmentsChange: (attachments) => {
      if (!options.submitting && !options.messageLocked) {
        options.attachmentDraft.replace(attachments);
      }
    },
    onPendingReadsChange: (delta) => options.attachmentDraft.updatePending(readSignal, delta),
    onInput: options.onInput,
    onVisibilityChange: options.onVisibilityChange,
    onSubmit: options.onSubmit,
  });
}
