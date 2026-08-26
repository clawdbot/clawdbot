import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import "../../components/tooltip.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { refreshSlashCommands } from "../chat/chat-commands.ts";
import {
  createChatAttachmentDropHandlers,
  handleChatAttachmentPaste,
  renderAttachmentPreview,
  renderChatAttachmentInputs,
} from "../chat/components/chat-attachments.ts";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  paneDomId,
  scheduleTextareaHeightAdjustment,
} from "../chat/components/chat-composer-dom.ts";
import type { ChatComposerPlusMenuView } from "../chat/components/chat-composer-plus-menu.ts";
import {
  createSkillMenuState,
  getActiveSkillMenuOptionId,
  getActiveSkillMenuOptionLabel,
  handleSkillMenuKeydown,
  isSkillMenuVisible,
  renderSkillMenu,
  resetSkillMenuState,
  updateSkillMenu,
  type SkillMenuHost,
} from "../chat/components/chat-composer-skill-menu.ts";
import {
  createSlashMenuState,
  getActiveSlashMenuOptionId,
  getActiveSlashMenuOptionLabel,
  handleSlashMenuKeydown,
  isSlashMenuVisible,
  renderSlashMenu,
  resetSlashMenuState,
  type SlashMenuHost,
  updateSlashMenu,
} from "../chat/components/chat-composer-slash-menu.ts";
import type { CapabilityMenuProps } from "../chat/components/chat-composer-types.ts";
import { insertComposerDictation } from "../chat/composer-dictation.ts";
import type { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import {
  renderNewSessionDraftVisibility,
  renderNewSessionPlusMenu,
  renderNewSessionSelectionStatus,
} from "./composer-capability-controls.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import type { NewSessionModelControl } from "./model-control.ts";

type NewSessionComposerOptions = {
  attachmentLimits?: { maxBytes: number; maxImageBytes: number };
  attachments: ChatAttachment[];
  canSubmit: boolean;
  getAttachments: () => ChatAttachment[];
  message: string;
  modelControl?: TemplateResult | typeof nothing;
  permissionControl?: TemplateResult | typeof nothing;
  pendingAttachmentReads: number;
  readSignal: AbortSignal;
  requiresModifier: boolean;
  requestUpdate: () => void;
  refreshCommands?: () => void | Promise<void>;
  submitDisabledReason?: string;
  blockedSubmitNotice?: string;
  terminalAction?: {
    canStart: boolean;
    disabledReason?: string;
    onStart: () => void;
  };
  submitting: boolean;
  textareaController: NewSessionComposerTextareaController;
  voiceControl?: TemplateResult;
  messageLocked?: boolean;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  capabilityMenu?: CapabilityMenuProps;
  toolOverrides?: SessionToolOverrides | null;
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onPendingReadsChange: (delta: 1 | -1) => void;
  onInput: (message: string) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
};

function submitNewSession(options: NewSessionComposerOptions) {
  resetSkillMenuState(options.textareaController.skillMenuState);
  resetSlashMenuState(options.textareaController.slashMenuState);
  options.onSubmit();
}

function renderStartControl(options: NewSessionComposerOptions) {
  const startLabel = options.submitting ? t("newSession.starting") : t("newSession.start");
  if (!options.terminalAction) {
    return html`
      <openclaw-tooltip content=${options.submitDisabledReason ?? t("newSession.start")}>
        <button
          type="button"
          class="chat-send-btn new-session-page__start-submit"
          ?disabled=${!options.canSubmit}
          aria-busy=${String(options.submitting)}
          aria-label=${startLabel}
          @click=${() => submitNewSession(options)}
        >
          ${options.submitting ? icons.loader : icons.arrowUp}
        </button>
      </openclaw-tooltip>
    `;
  }
  const terminalLabel = t("newSession.startInTerminal");
  return html`
    <div class="new-session-page__start-split">
      <openclaw-tooltip content=${options.submitDisabledReason ?? t("newSession.start")}>
        <button
          type="button"
          class="chat-send-btn new-session-page__start-submit new-session-page__start-primary"
          ?disabled=${!options.canSubmit}
          aria-busy=${String(options.submitting)}
          aria-label=${startLabel}
          @click=${() => submitNewSession(options)}
        >
          ${options.submitting ? icons.loader : icons.arrowUp}
        </button>
      </openclaw-tooltip>
      <openclaw-tooltip content=${options.terminalAction.disabledReason ?? terminalLabel}>
        <wa-dropdown class="new-session-page__start-menu" placement="top-end">
          <button
            slot="trigger"
            type="button"
            class="chat-send-btn new-session-page__start-menu-trigger"
            ?disabled=${!options.terminalAction.canStart}
            aria-label=${terminalLabel}
          >
            ${icons.chevronUp}
          </button>
          <wa-dropdown-item
            value="start-terminal"
            ?disabled=${!options.terminalAction.canStart}
            @click=${() => {
              if (options.terminalAction?.canStart) {
                options.terminalAction.onStart();
              }
            }}
          >
            ${terminalLabel}
          </wa-dropdown-item>
        </wa-dropdown>
      </openclaw-tooltip>
    </div>
  `;
}

export class NewSessionComposerTextareaController {
  private textarea: HTMLTextAreaElement | null = null;
  private placeholderFrame: number | null = null;
  private placeholderStartedAt: number | null = null;
  private placeholderText = "";
  private placeholderTarget = "";
  private placeholderEntered = false;
  private capturedSelection: { start: number; end: number } | null = null;
  private skillCommandClient: GatewayBrowserClient | null = null;
  private skillCommandAgentId = "";
  private skillCommandDraftOwnerKey = "";
  readonly skillMenuState = createSkillMenuState();
  readonly slashMenuState = createSlashMenuState();
  capabilityMenuOpen = false;
  capabilityMenuView: ChatComposerPlusMenuView = "root";

  readonly ref = (element?: Element) => {
    const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
    if (this.textarea && this.textarea !== nextTextarea) {
      disconnectTextareaOverflowObserver(this.textarea);
    }
    if (this.textarea && !nextTextarea) {
      this.resetPlaceholder();
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

  getPlaceholder(target: string, message: string, requestUpdate: () => void) {
    if (message.length > 0 || this.placeholderEntered) {
      this.placeholderEntered = true;
      if (this.placeholderFrame !== null) {
        globalThis.cancelAnimationFrame?.(this.placeholderFrame);
        this.placeholderFrame = null;
      }
      return target;
    }
    if (this.placeholderTarget !== target) {
      this.resetPlaceholder();
      this.placeholderTarget = target;
    }
    const requestFrame = globalThis.requestAnimationFrame?.bind(globalThis);
    if (
      !requestFrame ||
      (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
    ) {
      this.placeholderText = target;
      this.placeholderEntered = true;
      return target;
    }
    if (this.placeholderFrame === null) {
      const step = (timestamp: number) => {
        this.placeholderStartedAt ??= timestamp;
        const elapsed = Math.max(0, timestamp - this.placeholderStartedAt - 220);
        const length = Math.min(target.length, Math.floor(elapsed / 36));
        if (length !== this.placeholderText.length) {
          this.placeholderText = target.slice(0, length);
          requestUpdate();
        }
        if (length < target.length) {
          this.placeholderFrame = requestFrame(step);
          return;
        }
        this.placeholderFrame = null;
        this.placeholderEntered = true;
      };
      this.placeholderFrame = requestFrame(step);
    }
    return this.placeholderText;
  }

  private resetPlaceholder() {
    if (this.placeholderFrame !== null) {
      globalThis.cancelAnimationFrame?.(this.placeholderFrame);
      this.placeholderFrame = null;
    }
    this.placeholderStartedAt = null;
    this.placeholderText = "";
    this.placeholderTarget = "";
    this.placeholderEntered = false;
  }

  /**
   * Remembers where the caret was before another control takes focus. Pressing
   * the microphone blurs the draft, so the caret has to be read while it still
   * belongs to the writer rather than when the transcript arrives.
   */
  captureSelection() {
    const target = this.textarea;
    this.capturedSelection = target
      ? { start: target.selectionStart, end: target.selectionEnd }
      : null;
  }

  /**
   * Writes a transcript into the draft at the remembered caret and returns the
   * new draft, or null when there is nothing to insert.
   *
   * The element is the draft here, not a copy of it: it holds keystrokes that
   * have not been committed upward yet, so reading the committed value instead
   * would insert into a stale draft and drop them. It is written directly too,
   * so the box grows with the speech before the next render commits.
   */
  insertTranscript(transcript: string): string | null {
    const target = this.textarea;
    if (!target) {
      return null;
    }
    const value = target.value;
    const selection = this.capturedSelection ?? { start: value.length, end: value.length };
    this.capturedSelection = null;
    const insertion = insertComposerDictation(value, transcript, selection.start, selection.end);
    if (insertion.value === value) {
      return null;
    }
    target.value = insertion.value;
    adjustTextareaHeight(target);
    queueMicrotask(() => {
      if (!target.isConnected) {
        return;
      }
      target.focus({ preventScroll: true });
      target.selectionStart = insertion.caret;
      target.selectionEnd = insertion.caret;
    });
    return insertion.value;
  }

  readonly getTextarea = () => this.textarea;

  syncSkillCommandOwner(
    client: GatewayBrowserClient | null,
    agentId: string,
    draftOwnerKey: string,
  ) {
    const normalizedAgentId = agentId.trim();
    if (
      this.skillCommandClient === client &&
      this.skillCommandAgentId === normalizedAgentId &&
      this.skillCommandDraftOwnerKey === draftOwnerKey
    ) {
      return;
    }
    // The controller survives route, agent, and Gateway changes. Invalidate its
    // menu generation so a prior owner cannot publish into the next draft.
    this.skillCommandClient = client;
    this.skillCommandAgentId = normalizedAgentId;
    this.skillCommandDraftOwnerKey = draftOwnerKey;
    resetSkillMenuState(this.skillMenuState);
  }

  ownsSkillCommands(client: GatewayBrowserClient, agentId: string, draftOwnerKey: string): boolean {
    return (
      this.skillCommandClient === client &&
      this.skillCommandAgentId === agentId.trim() &&
      this.skillCommandDraftOwnerKey === draftOwnerKey
    );
  }

  disconnect() {
    this.resetPlaceholder();
    this.skillCommandClient = null;
    this.skillCommandAgentId = "";
    this.skillCommandDraftOwnerKey = "";
    resetSkillMenuState(this.skillMenuState);
    resetSlashMenuState(this.slashMenuState);
    this.capabilityMenuOpen = false;
    this.capabilityMenuView = "root";
    if (this.textarea) {
      disconnectTextareaOverflowObserver(this.textarea);
      this.textarea = null;
    }
  }
}

export function renderDraftError(message: string, action?: { label: string; onClick: () => void }) {
  return html`
    <div class="callout danger new-session-page__error new-session-page__alert" role="alert">
      <span class="new-session-page__alert-icon" aria-hidden="true">${icons.alertTriangle}</span>
      <span class="callout__content new-session-page__alert-message"
        >${formatUiError(message)}</span
      >
      ${action
        ? html`<button class="btn btn--sm" type="button" @click=${action.onClick}>
            ${action.label}
          </button>`
        : nothing}
    </div>
  `;
}

function handleComposerKeydown(
  event: KeyboardEvent,
  options: NewSessionComposerOptions,
  skillMenuHost: SkillMenuHost,
  slashMenuHost: SlashMenuHost,
) {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  if (
    handleSkillMenuKeydown(
      event,
      options.textareaController.skillMenuState,
      skillMenuHost,
      options.requestUpdate,
    )
  ) {
    return;
  }
  if (
    handleSlashMenuKeydown(
      event,
      options.textareaController.slashMenuState,
      slashMenuHost,
      options.requestUpdate,
    )
  ) {
    return;
  }
  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }
  if (options.requiresModifier && !event.metaKey && !event.ctrlKey) {
    return;
  }
  // A reasoned gate still consumes the press: the submission flow records the
  // attempt and surfaces the reason instead of silently inserting a newline.
  // Only silent gates (busy button, empty draft) keep Enter native.
  if (options.canSubmit || options.submitDisabledReason !== undefined) {
    event.preventDefault();
    submitNewSession(options);
  }
}

/** Draft message box styled as the chat composer shell so both pickers match. */
function renderNewSessionComposer(options: NewSessionComposerOptions) {
  const skillMenuState = options.textareaController.skillMenuState;
  const slashMenuState = options.textareaController.slashMenuState;
  const skillMenuHost: SkillMenuHost = {
    paneId: "new-session",
    getDraft: () => options.textareaController.getTextarea()?.value ?? options.message,
    commitDraft: options.onInput,
    getTextarea: options.textareaController.getTextarea,
    refreshCommands: options.refreshCommands,
  };
  const slashMenuHost: SlashMenuHost = {
    paneId: skillMenuHost.paneId,
    getDraft: skillMenuHost.getDraft,
    commitDraft: skillMenuHost.commitDraft,
    resolveArgOptions: (command) => command.argOptions ?? [],
    runCommand: () => submitNewSession(options),
    refreshCommands: options.refreshCommands,
    commandFilter: (command) => command.executeLocal !== true,
  };
  const updateMenus = (target: HTMLTextAreaElement) => {
    updateSlashMenu(target.value, slashMenuState, slashMenuHost, options.requestUpdate);
    updateSkillMenu(
      target.value,
      target.selectionStart,
      skillMenuState,
      skillMenuHost,
      options.requestUpdate,
    );
  };
  const handleSelect = (event: Event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLTextAreaElement) {
      updateSkillMenu(
        target.value,
        target.selectionStart,
        skillMenuState,
        skillMenuHost,
        options.requestUpdate,
      );
    }
  };
  const attachmentProps = {
    attachmentLimits: options.attachmentLimits,
    attachments: options.attachments,
    disabled: options.submitting || options.messageLocked,
    getAttachments: options.getAttachments,
    draft: options.message,
    getDraft: () => options.message,
    onAttachmentsChange: options.onAttachmentsChange,
    onDraftChange: options.onInput,
    onPendingReadsChange: options.onPendingReadsChange,
    onOpenImage: options.onOpenImage,
    readSignal: options.readSignal,
  };
  const attachmentDropHandlers = createChatAttachmentDropHandlers({
    ...attachmentProps,
    canCompose: !options.submitting && !options.messageLocked,
  });
  options.textareaController.syncDraft(options.message);
  const messagePlaceholder = t("newSession.messagePlaceholder");
  const animatedPlaceholder = options.textareaController.getPlaceholder(
    messagePlaceholder,
    options.message,
    options.requestUpdate,
  );
  const skillMenuVisible =
    !options.submitting && !options.messageLocked && isSkillMenuVisible(skillMenuState);
  const slashMenuVisible =
    !options.submitting && !options.messageLocked && isSlashMenuVisible(slashMenuState);
  const menuVisible = skillMenuVisible || slashMenuVisible;
  const menuListboxId = paneDomId(
    skillMenuHost.paneId,
    skillMenuVisible ? "skill-menu-listbox" : "slash-menu-listbox",
  );
  const activeMenuOptionId = skillMenuVisible
    ? getActiveSkillMenuOptionId(skillMenuState, skillMenuHost.paneId)
    : getActiveSlashMenuOptionId(slashMenuState, slashMenuHost.paneId);
  const activeMenuOptionLabel = skillMenuVisible
    ? getActiveSkillMenuOptionLabel(skillMenuState)
    : getActiveSlashMenuOptionLabel(slashMenuState);
  const menuAnnouncementId = paneDomId(skillMenuHost.paneId, "active-menu-announcement");
  return html`
    <div
      class="agent-chat__composer-shell new-session-page__composer"
      @drop=${attachmentDropHandlers.onDrop}
      @dragenter=${attachmentDropHandlers.onDragenter}
      @dragleave=${attachmentDropHandlers.onDragleave}
      @dragover=${attachmentDropHandlers.onDragover}
    >
      <div class="agent-chat__input">
        ${renderChatAttachmentInputs(attachmentProps)} ${renderAttachmentPreview(attachmentProps)}
        <div class="agent-chat__composer-input-row">
          <div class="agent-chat__composer-combobox">
            ${slashMenuVisible
              ? renderSlashMenu(
                  slashMenuState,
                  slashMenuHost,
                  options.message,
                  options.requestUpdate,
                )
              : nothing}
            ${skillMenuVisible
              ? renderSkillMenu(skillMenuState, skillMenuHost, options.requestUpdate)
              : nothing}
            <textarea
              ${ref(options.textareaController.ref)}
              class="new-session-page__message"
              rows="1"
              ?disabled=${options.submitting || options.messageLocked}
              placeholder=${animatedPlaceholder}
              aria-label=${messagePlaceholder}
              .value=${options.message}
              aria-autocomplete="list"
              aria-controls=${ifDefined(menuVisible ? menuListboxId : undefined)}
              aria-expanded=${ifDefined(menuVisible ? "true" : undefined)}
              aria-activedescendant=${ifDefined(activeMenuOptionId ?? undefined)}
              aria-describedby=${menuAnnouncementId}
              @input=${(event: Event) => {
                const target = event.target as HTMLTextAreaElement;
                adjustTextareaHeight(target);
                updateMenus(target);
                options.onInput(target.value);
              }}
              @select=${handleSelect}
              @keydown=${(event: KeyboardEvent) =>
                handleComposerKeydown(event, options, skillMenuHost, slashMenuHost)}
              @paste=${(event: ClipboardEvent) => {
                if (!options.submitting && !options.messageLocked) {
                  handleChatAttachmentPaste(event, attachmentProps);
                }
              }}
            ></textarea>
            <span
              id=${menuAnnouncementId}
              class="sr-only"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              >${activeMenuOptionLabel}</span
            >
          </div>
        </div>
        <div class="agent-chat__composer-footer">
          <div class="agent-chat__composer-lead">
            ${renderNewSessionPlusMenu(options, attachmentProps)}
            ${options.permissionControl ?? nothing}
            ${options.draftAvailable ? renderNewSessionDraftVisibility(options) : nothing}
            ${renderNewSessionSelectionStatus(options)}
          </div>
          <div class="agent-chat__composer-trail">
            <div class="agent-chat__composer-controls">
              ${options.modelControl && options.modelControl !== nothing
                ? html`<div class="chat-composer-model-control">${options.modelControl}</div>`
                : nothing}
            </div>
            <div class="agent-chat__composer-actions">
              ${options.voiceControl ?? nothing}${renderStartControl(options)}
            </div>
          </div>
        </div>
        ${options.blockedSubmitNotice
          ? html`<div class="new-session-page__blocked-submit" role="status">
              ${options.blockedSubmitNotice}
            </div>`
          : nothing}
        ${options.pendingAttachmentReads > 0
          ? html`<span class="sr-only" role="status">${t("newSession.readingAttachment")}</span>`
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
  draftOwnerKey: string;
  isCatalogTarget: boolean;
  message: string;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  capabilityMenu?: CapabilityMenuProps;
  toolOverrides?: SessionToolOverrides | null;
  modelControl: NewSessionModelControl;
  permissionControl?: TemplateResult;
  textareaController: NewSessionComposerTextareaController;
  voiceControl?: TemplateResult;
  requiresModifier: boolean;
  requestUpdate: () => void;
  submitDisabledReason?: string;
  blockedSubmitNotice?: string;
  terminalAction?: {
    canStart: boolean;
    disabledReason?: string;
    onStart: () => void;
  };
  submitting: boolean;
  messageLocked?: boolean;
  onInput: (message: string) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
}) {
  const readSignal = options.attachmentDraft.readSignal;
  const commandClient = options.context?.gateway.snapshot.client ?? null;
  options.textareaController.syncSkillCommandOwner(
    commandClient,
    options.agentId,
    options.draftOwnerKey,
  );
  return renderNewSessionComposer({
    attachmentLimits: options.context?.gateway.snapshot.hello?.policy?.attachments,
    attachments: options.attachmentDraft.attachments,
    canSubmit: options.canSubmit,
    getAttachments: () => options.attachmentDraft.attachments,
    message: options.message,
    visibility: options.visibility,
    draftAvailable: options.draftAvailable,
    capabilityMenu: options.capabilityMenu,
    toolOverrides: options.toolOverrides,
    modelControl: options.isCatalogTarget
      ? nothing
      : options.modelControl.render({
          agent: options.agent,
          agentId: options.agentId,
          context: options.context,
          sending: options.submitting,
        }),
    permissionControl: options.permissionControl,
    pendingAttachmentReads: options.attachmentDraft.pendingReads,
    readSignal,
    requiresModifier: options.requiresModifier,
    requestUpdate: options.requestUpdate,
    refreshCommands: commandClient
      ? () =>
          refreshSlashCommands({
            client: commandClient,
            agentId: options.agentId,
            shouldApply: () =>
              options.textareaController.ownsSkillCommands(
                commandClient,
                options.agentId,
                options.draftOwnerKey,
              ),
          })
      : undefined,
    submitDisabledReason: options.submitDisabledReason,
    blockedSubmitNotice: options.blockedSubmitNotice,
    terminalAction: options.terminalAction,
    submitting: options.submitting,
    textareaController: options.textareaController,
    voiceControl: options.voiceControl,
    messageLocked: options.messageLocked,
    onAttachmentsChange: (attachments) => {
      if (!options.submitting && !options.messageLocked) {
        options.attachmentDraft.replace(attachments);
      }
    },
    onPendingReadsChange: (delta) => options.attachmentDraft.updatePending(readSignal, delta),
    onInput: options.onInput,
    onOpenImage: options.onOpenImage,
    onVisibilityChange: options.onVisibilityChange,
    onSubmit: options.onSubmit,
  });
}
