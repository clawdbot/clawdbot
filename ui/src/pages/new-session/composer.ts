import { html, nothing, type TemplateResult } from "lit";
import { guard } from "lit/directives/guard.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { live } from "lit/directives/live.js";
import { ref } from "lit/directives/ref.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import "../../components/tooltip.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions, type HumanMentionInput } from "../../lib/chat/human-mentions.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
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
import {
  HumanMentionMenu,
  renderSelectedHumanMentions,
  type HumanMentionDirectory,
  type HumanMentionMenuHost,
} from "../chat/components/chat-composer-mention-menu.ts";
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
import { ensureChatComposerPickerDismissal } from "../chat/components/chat-picker-overlay.ts";
import { insertComposerDictation } from "../chat/composer-dictation.ts";
import {
  renderNewSessionDraftVisibility,
  renderNewSessionPlusMenu,
  renderNewSessionSelectionStatus,
} from "./composer-capability-controls.ts";
import type { NewSessionVisibility } from "./create-params.ts";

export type NewSessionComposerOptions = {
  attachmentLimits?: { maxBytes: number; maxImageBytes: number };
  attachments: ChatAttachment[];
  canSubmit: boolean;
  getAttachments: () => ChatAttachment[];
  message: string;
  mentions?: readonly HumanMention[];
  getMentions?: () => readonly HumanMention[];
  mentionDirectory?: HumanMentionDirectory;
  modelControl?: TemplateResult | typeof nothing;
  permissionControl?: TemplateResult | typeof nothing;
  pendingAttachmentReads: number;
  readSignal: AbortSignal;
  requiresModifier: boolean;
  requestUpdate: () => void;
  refreshCommands?: () => void | Promise<void>;
  submitDisabledReason?: string;
  blockedSubmitNotice?: string;
  dictationActive?: boolean;
  dictationPreview?: string;
  dictationStatus?: TemplateResult | typeof nothing;
  nativeTerminal?: boolean;
  onUnsupportedAttachment?: () => void;
  submitting: boolean;
  textareaController: NewSessionComposerTextareaController;
  voiceControl?: TemplateResult | typeof nothing;
  messageLocked?: boolean;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  capabilityMenu?: CapabilityMenuProps;
  toolOverrides?: SessionToolOverrides | null;
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onPendingReadsChange: (delta: 1 | -1) => void;
  onInput: (message: string, mentions?: readonly HumanMention[]) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
  onBackgroundSubmit?: () => void;
};

function submitNewSession(options: NewSessionComposerOptions) {
  options.textareaController.mentionMenu.close();
  resetSkillMenuState(options.textareaController.skillMenuState);
  resetSlashMenuState(options.textareaController.slashMenuState);
  options.onSubmit();
}

function renderStartControl(options: NewSessionComposerOptions) {
  const startLabel = options.submitting
    ? t("newSession.starting")
    : t(options.nativeTerminal ? "newSession.startInTerminal" : "newSession.start");
  const reasonedBlock = !options.canSubmit && options.submitDisabledReason !== undefined;
  return html` <openclaw-tooltip content=${options.submitDisabledReason ?? startLabel}>
    <button
      type="button"
      class="chat-send-btn new-session-page__start-submit ${reasonedBlock
        ? "new-session-page__start-submit--blocked"
        : ""}"
      ?disabled=${!options.canSubmit && !reasonedBlock}
      aria-disabled=${String(!options.canSubmit)}
      aria-busy=${String(options.submitting)}
      aria-label=${startLabel}
      @click=${() => submitNewSession(options)}
    >
      ${options.submitting
        ? icons.loader
        : options.nativeTerminal
          ? icons.squareTerminal
          : icons.arrowUp}
    </button>
  </openclaw-tooltip>`;
}

export class NewSessionComposerTextareaController {
  private textarea: HTMLTextAreaElement | null = null;
  private placeholderFrame: number | null = null;
  private placeholderStartedAt: number | null = null;
  private placeholderText = "";
  private placeholderTarget = "";
  private placeholderEntered = false;
  private capturedSelection: { start: number; end: number; value: string } | null = null;
  private skillCommandClient: GatewayBrowserClient | null = null;
  private skillCommandAgentId = "";
  private skillCommandDraftOwnerKey = "";
  readonly skillMenuState = createSkillMenuState();
  readonly slashMenuState = createSlashMenuState();
  readonly mentionMenu = new HumanMentionMenu();
  mentionInput?: HumanMentionInput;
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
        const elapsed = Math.max(0, timestamp - this.placeholderStartedAt - 180);
        const length = Math.min(target.length, Math.floor(elapsed / 26));
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
   * Remembers the live draft and caret before another control takes focus.
   * Partial previews rewrite the textarea, so commit must keep using this base
   * snapshot or each successive transcript would be inserted into the last preview.
   */
  captureSelection() {
    const target = this.textarea;
    this.capturedSelection = target
      ? { start: target.selectionStart, end: target.selectionEnd, value: target.value }
      : null;
  }

  previewTranscript(transcript: string): string | undefined {
    const target = this.textarea;
    if (!target) {
      return undefined;
    }
    const selection = this.capturedSelection ?? {
      start: target.selectionStart,
      end: target.selectionEnd,
      value: target.value,
    };
    return insertComposerDictation(selection.value, transcript, selection.start, selection.end)
      .value;
  }

  /**
   * Writes a transcript into the draft at the remembered caret and returns the
   * new draft, or null when there is nothing to insert.
   *
   * The captured element value includes keystrokes not yet committed upward.
   * Writing the final insertion directly grows the box before the next render
   * commits that same value into the page-owned draft.
   */
  insertTranscript(transcript: string, late?: true): string | null {
    const target = this.textarea;
    if (!target) {
      return null;
    }
    const captured = this.capturedSelection;
    // Delayed finals must not replace edits made after Stop unlocked this draft.
    const selection =
      captured && (!late || captured.value === target.value)
        ? captured
        : {
            start: late ? target.selectionStart : target.value.length,
            end: late ? target.selectionEnd : target.value.length,
            value: target.value,
          };
    this.capturedSelection = null;
    const insertion = insertComposerDictation(
      selection.value,
      transcript,
      selection.start,
      selection.end,
    );
    if (insertion.value === selection.value) {
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
    this.mentionMenu.dispose();
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

function handleComposerKeydown(
  event: KeyboardEvent,
  options: NewSessionComposerOptions,
  skillMenuHost: SkillMenuHost,
  slashMenuHost: SlashMenuHost,
  mentionMenuHost: HumanMentionMenuHost,
) {
  if (options.dictationActive) {
    return;
  }
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  if (
    options.textareaController.mentionMenu.handleKeydown(
      event,
      mentionMenuHost,
      options.requestUpdate,
    )
  ) {
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
  if (event.key !== "Enter") {
    return;
  }
  const hasSubmitModifier = event.metaKey || event.ctrlKey;
  const isBackgroundShortcut = options.requiresModifier
    ? hasSubmitModifier && event.shiftKey
    : hasSubmitModifier && !event.shiftKey;
  if (!event.altKey && isBackgroundShortcut && options.onBackgroundSubmit) {
    if (options.canSubmit || options.submitDisabledReason !== undefined) {
      event.preventDefault();
      resetSkillMenuState(options.textareaController.skillMenuState);
      resetSlashMenuState(options.textareaController.slashMenuState);
      options.textareaController.mentionMenu.close();
      options.onBackgroundSubmit();
    }
    return;
  }
  if (event.shiftKey || (options.requiresModifier && !hasSubmitModifier)) {
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
export function renderNewSessionComposer(options: NewSessionComposerOptions) {
  const skillMenuState = options.textareaController.skillMenuState;
  const slashMenuState = options.textareaController.slashMenuState;
  const mentionMenu = options.textareaController.mentionMenu;
  mentionMenu.syncDirectory(
    options.submitting || options.messageLocked || options.dictationActive
      ? undefined
      : options.mentionDirectory,
  );
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
    getTextarea: skillMenuHost.getTextarea,
    resolveArgOptions: (command) => command.argOptions ?? [],
    runCommand: () => submitNewSession(options),
    canRunInlineCommand: () => false,
    refreshCommands: options.refreshCommands,
    commandFilter: (command) => command.executeLocal !== true,
  };
  const mentionMenuHost: HumanMentionMenuHost = {
    paneId: skillMenuHost.paneId,
    getDraft: skillMenuHost.getDraft,
    getTextarea: skillMenuHost.getTextarea,
    getMentions: () => options.getMentions?.() ?? options.mentions ?? [],
    commitDraft: options.onInput,
  };
  const updateMenus = (target: HTMLTextAreaElement, event?: InputEvent) => {
    if (options.nativeTerminal) {
      return;
    }
    updateSlashMenu(target.value, slashMenuState, slashMenuHost, options.requestUpdate);
    updateSkillMenu(
      target.value,
      target.selectionStart,
      skillMenuState,
      skillMenuHost,
      options.requestUpdate,
    );
    if (
      event?.inputType === "insertFromPaste" ||
      event?.inputType === "insertFromDrop" ||
      event?.isComposing
    ) {
      mentionMenu.close();
    } else {
      mentionMenu.update(
        target.value,
        target.selectionStart,
        options.requestUpdate,
        event?.inputType === "insertText" && event.data?.includes("@") === true,
      );
    }
  };
  const handleSelect = (event: Event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLTextAreaElement) {
      updateMenus(target);
    }
  };
  const composerLocked =
    options.submitting || options.messageLocked === true || options.dictationActive === true;
  const attachmentProps = {
    attachmentLimits: options.attachmentLimits,
    attachments: options.attachments,
    disabled: composerLocked,
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
    canCompose: !composerLocked && !options.nativeTerminal,
  });
  const visibleMessage = options.dictationPreview ?? options.message;
  options.textareaController.syncDraft(visibleMessage);
  const messagePlaceholder = t(
    options.nativeTerminal ? "newSession.nativeTerminalPrompt" : "newSession.messagePlaceholder",
  );
  const animatedPlaceholder = options.dictationActive
    ? ""
    : options.textareaController.getPlaceholder(
        messagePlaceholder,
        options.message,
        options.requestUpdate,
      );
  const skillMenuVisible =
    !options.nativeTerminal && !composerLocked && isSkillMenuVisible(skillMenuState);
  const slashMenuVisible =
    !options.nativeTerminal && !composerLocked && isSlashMenuVisible(slashMenuState);
  const menuVisible = skillMenuVisible || slashMenuVisible || mentionMenu.open;
  if (mentionMenu.open) {
    ensureChatComposerPickerDismissal();
  }
  const menuListboxId = paneDomId(
    skillMenuHost.paneId,
    mentionMenu.open
      ? "mention-menu-listbox"
      : skillMenuVisible
        ? "skill-menu-listbox"
        : "slash-menu-listbox",
  );
  const activeMenuOptionId = mentionMenu.open
    ? mentionMenu.activeId(skillMenuHost.paneId)
    : skillMenuVisible
      ? getActiveSkillMenuOptionId(skillMenuState, skillMenuHost.paneId)
      : getActiveSlashMenuOptionId(slashMenuState, slashMenuHost.paneId);
  const activeMenuOptionLabel = mentionMenu.open
    ? mentionMenu.activeLabel()
    : skillMenuVisible
      ? getActiveSkillMenuOptionLabel(skillMenuState)
      : getActiveSlashMenuOptionLabel(slashMenuState);
  const menuAnnouncementId = paneDomId(skillMenuHost.paneId, "active-menu-announcement");
  const ordinaryShortcut = options.requiresModifier ? "Control+Enter Meta+Enter" : "Enter";
  const backgroundShortcut = options.requiresModifier
    ? "Control+Shift+Enter Meta+Shift+Enter"
    : "Control+Enter Meta+Enter";
  const keyShortcuts = options.onBackgroundSubmit
    ? `${ordinaryShortcut} ${backgroundShortcut}`
    : ordinaryShortcut;
  return html`
    <div
      class="agent-chat__composer-shell new-session-page__composer"
      @drop=${(event: DragEvent) => {
        if (options.nativeTerminal && event.dataTransfer?.files.length) {
          event.preventDefault();
          options.onUnsupportedAttachment?.();
        } else {
          attachmentDropHandlers.onDrop(event);
        }
      }}
      @dragenter=${attachmentDropHandlers.onDragenter}
      @dragleave=${attachmentDropHandlers.onDragleave}
      @dragover=${attachmentDropHandlers.onDragover}
    >
      <div
        class="agent-chat__input agent-chat__input--mobile-toolbar${options.dictationActive
          ? " agent-chat__input--dictating"
          : ""}"
        @openclaw-composer-dismiss-invocations=${() => {
          mentionMenu.close();
          options.requestUpdate();
        }}
      >
        ${mentionMenu.render(mentionMenuHost, options.requestUpdate)}
        ${options.nativeTerminal ? nothing : renderChatAttachmentInputs(attachmentProps)}
        ${renderAttachmentPreview(attachmentProps)}
        ${renderSelectedHumanMentions(options.message, options.mentions, () =>
          options.onInput(options.message, []),
        )}
        <div class="agent-chat__composer-lede">${options.dictationStatus ?? nothing}</div>
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
              ?autofocus=${globalThis.matchMedia?.("(max-width: 560px)")?.matches ?? false}
              ?disabled=${options.submitting || options.messageLocked}
              ?readonly=${options.dictationActive}
              placeholder=${animatedPlaceholder}
              aria-label=${messagePlaceholder}
              aria-keyshortcuts=${keyShortcuts}
              .value=${guard([visibleMessage], () => live(visibleMessage))}
              aria-autocomplete="list"
              aria-controls=${ifDefined(menuVisible ? menuListboxId : undefined)}
              aria-expanded=${ifDefined(menuVisible ? "true" : undefined)}
              aria-activedescendant=${ifDefined(activeMenuOptionId ?? undefined)}
              aria-describedby=${menuAnnouncementId}
              @input=${(event: InputEvent) => {
                if (options.dictationActive) {
                  return;
                }
                // SAFETY: this input listener is attached directly to the textarea below.
                const target = event.target as HTMLTextAreaElement;
                adjustTextareaHeight(target);
                const mentions = mentionMenuHost.getMentions();
                options.onInput(
                  target.value,
                  mentions.length
                    ? updateHumanMentions(
                        options.message,
                        target.value,
                        mentions,
                        options.textareaController.mentionInput,
                      )
                    : undefined,
                );
                options.textareaController.mentionInput = undefined;
                updateMenus(target, event);
              }}
              @beforeinput=${(event: InputEvent) => {
                // SAFETY: this beforeinput listener belongs to this native textarea.
                const target = event.target as HTMLTextAreaElement;
                options.textareaController.mentionInput = {
                  value: target.value,
                  start: target.selectionStart,
                  end: target.selectionEnd,
                  inputType: event.inputType,
                };
              }}
              @select=${handleSelect}
              @keydown=${(event: KeyboardEvent) =>
                handleComposerKeydown(
                  event,
                  options,
                  skillMenuHost,
                  slashMenuHost,
                  mentionMenuHost,
                )}
              @compositionstart=${() => {
                mentionMenu.close();
                options.requestUpdate();
              }}
              @paste=${(event: ClipboardEvent) => {
                if (options.nativeTerminal && event.clipboardData?.files.length) {
                  event.preventDefault();
                  options.onUnsupportedAttachment?.();
                } else if (!composerLocked && !options.nativeTerminal) {
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
            ${options.nativeTerminal ? nothing : renderNewSessionPlusMenu(options, attachmentProps)}
            ${options.permissionControl ?? nothing}
            ${!options.nativeTerminal && options.draftAvailable
              ? renderNewSessionDraftVisibility(options)
              : nothing}
            ${options.nativeTerminal ? nothing : renderNewSessionSelectionStatus(options)}
          </div>
          <div class="agent-chat__composer-trail">
            <div class="agent-chat__composer-controls">
              ${options.modelControl && options.modelControl !== nothing
                ? html`<div class="chat-composer-model-control">${options.modelControl}</div>`
                : nothing}
            </div>
            <div class="agent-chat__composer-actions">
              ${options.voiceControl ?? nothing}${options.dictationActive
                ? nothing
                : renderStartControl(options)}
            </div>
          </div>
        </div>
        ${options.pendingAttachmentReads > 0
          ? html`<span class="sr-only" role="status">${t("newSession.readingAttachment")}</span>`
          : nothing}
      </div>
      ${options.blockedSubmitNotice
        ? html`<div
            class="new-session-page__blocked-submit agent-chat__composer-underlaps"
            data-tone="info"
            role="status"
          >
            <div class="agent-chat__composer-status-band">
              <span class="agent-chat__composer-status-icon" aria-hidden="true">${icons.info}</span>
              <span class="agent-chat__composer-status-text">${options.blockedSubmitNotice}</span>
            </div>
          </div>`
        : nothing}
    </div>
  `;
}
