import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, svg, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { strokeIcon } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import { renderSessionProgressCard } from "../../../components/session-progress-card.ts";
import { t } from "../../../i18n/index.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import type { ComposerDictationController } from "../composer-dictation.ts";
import { insertComposerDictation } from "../composer-dictation.ts";
import {
  handleChatAttachmentPaste,
  renderAttachmentPreview,
  renderChatAttachmentInputs,
} from "./chat-attachments.ts";
import type { ChatRunControlsProps } from "./chat-composer-controls.ts";
import {
  renderChatPrimaryActions,
  renderComposerDictationStatus,
} from "./chat-composer-controls.ts";
import { focusComposerFromChrome, paneDomId } from "./chat-composer-dom.ts";
import { renderChatGoal } from "./chat-composer-goal.ts";
import { renderChatComposerPlusMenu } from "./chat-composer-plus-menu.ts";
import { renderChatQueue } from "./chat-composer-queue.ts";
import {
  resetSkillMenuState,
  renderSkillMenu,
  type SkillMenuHost,
} from "./chat-composer-skill-menu.ts";
import {
  renderSlashMenu,
  resetSlashMenuState,
  type SlashMenuHost,
} from "./chat-composer-slash-menu.ts";
import { commitComposerDraft } from "./chat-composer-state.ts";
import {
  renderChatRunStatusIndicator,
  renderCompactionIndicator,
  renderFallbackIndicator,
  type ComposerRunStatus,
} from "./chat-composer-status.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";
import {
  ensureChatComposerPickerDismissal,
  handleChatComposerDropdownShow,
  markPointerOpenedChatComposerDropdown,
  restorePointerOpenedChatComposerTrigger,
} from "./chat-picker-overlay.ts";
import type { createGatewayQuestionPanelProps } from "./chat-question-card.ts";
import { renderChatVoiceError } from "./chat-voice-activity.ts";

type ChatComposerViewContext = {
  props: ChatComposerProps;
  state: ChatComposerState;
  canCompose: boolean;
  showAbortableUi: boolean;
  activeSession: GatewaySessionRow | undefined;
  visibleDraft: string;
  contextNotice: TemplateResult | typeof nothing;
  composerControls: TemplateResult | typeof nothing;
  composerLeadControl: TemplateResult | typeof nothing;
  runStatusAnnouncement: string;
  composerRunStatus: ComposerRunStatus | null | undefined;
  requestUpdate: () => void;
  sendShortcut: "enter" | "modifier-enter";
  questionPanelProps: ReturnType<typeof createGatewayQuestionPanelProps> | null;
  showComposer: boolean;
  placeholder: string;
  handleKeyDown: (event: KeyboardEvent) => void;
  handleBeforeInput: (event: InputEvent) => void;
  handleInput: (event: InputEvent) => void;
  handleSelect: (event: Event) => void;
  draftKey: string;
  handleCompositionEnd: (event: CompositionEvent) => void;
  handleBlur: (event: FocusEvent) => void;
  dictation: ComposerDictationController | undefined;
  runControlsProps: ChatRunControlsProps;
  mirrorCameraPreview: boolean;
  slashMenuVisible: boolean;
  skillMenuVisible: boolean;
  skillMenuHost: SkillMenuHost;
  slashMenuHost: SlashMenuHost;
  activeSlashMenuOptionId: string | null;
  activeSlashMenuOptionLabel: string;
  slashMenuListboxId: string;
  slashMenuAnnouncementId: string;
};

const globeOffIcon = strokeIcon(svg` <path
    d="M10.114 4.462A14.5 14.5 0 0 1 12 2a10 10 0 0 1 9.313 13.643"
  />
  <path d="M15.557 15.556A14.5 14.5 0 0 1 12 22 10 10 0 0 1 4.929 4.929" />
  <path d="M15.892 10.234A14.5 14.5 0 0 0 12 2a10 10 0 0 0-3.643.687" />
  <path d="M17.656 12H22" />
  <path d="M19.071 19.071A10 10 0 0 1 12 22 14.5 14.5 0 0 1 8.44 8.45" />
  <path d="M2 12h10" />
  <path d="m2 2 20 20" />`);

export function renderChatComposerView(context: ChatComposerViewContext) {
  const {
    props,
    state,
    canCompose,
    showAbortableUi,
    activeSession,
    visibleDraft,
    contextNotice,
    composerControls,
    composerLeadControl,
    runStatusAnnouncement,
    composerRunStatus,
    requestUpdate,
    sendShortcut,
    questionPanelProps,
    showComposer,
    placeholder,
    handleKeyDown,
    handleBeforeInput,
    handleInput,
    handleSelect,
    draftKey,
    handleCompositionEnd,
    handleBlur,
    dictation,
    runControlsProps,
    mirrorCameraPreview,
    slashMenuVisible,
    skillMenuVisible,
    skillMenuHost,
    slashMenuHost,
    activeSlashMenuOptionId,
    activeSlashMenuOptionLabel,
    slashMenuListboxId,
    slashMenuAnnouncementId,
  } = context;
  if (slashMenuVisible || skillMenuVisible) {
    ensureChatComposerPickerDismissal();
  }
  const disabledBanner = props.disabledBanner
    ? html`
        <div
          class="agent-chat__disabled-banner ${props.disabledBanner.kind === "composer-replacement"
            ? "agent-chat__disabled-banner--replacement"
            : ""} callout ${props.disabledBanner.tone === "neutral"
            ? "agent-chat__disabled-banner--neutral"
            : "info"} callout--action"
          role="status"
        >
          ${props.disabledBanner.icon
            ? html`<span
                class="agent-chat__disabled-banner-icon agent-chat__disabled-banner-icon--${props
                  .disabledBanner.icon}"
                aria-hidden="true"
                >${props.disabledBanner.icon === "archive"
                  ? icons.archive
                  : icons.alertTriangle}</span
              >`
            : nothing}
          <div class="callout__content">
            ${props.disabledBanner.title
              ? html`<div class="agent-chat__disabled-banner-title">
                  ${props.disabledBanner.title}
                </div>`
              : nothing}
            <div class="agent-chat__disabled-banner-detail">${props.disabledBanner.text}</div>
          </div>
          <button
            type="button"
            class="btn btn--sm ${props.disabledBanner.actionStyle ?? ""}"
            ?disabled=${Boolean(props.disabledBanner.disabledReason) || props.disabledBanner.busy}
            aria-busy=${props.disabledBanner.busy ? "true" : "false"}
            title=${props.disabledBanner.disabledReason ?? nothing}
            @click=${props.disabledBanner.onAction}
          >
            ${props.disabledBanner.busy
              ? html`<span class="btn__spinner" aria-hidden="true"></span>${props.disabledBanner
                    .busyLabel ?? props.disabledBanner.actionLabel}`
              : props.disabledBanner.actionLabel}
          </button>
          ${props.disabledBanner.kind === "composer-replacement" && showAbortableUi
            ? renderChatPrimaryActions(runControlsProps)
            : nothing}
        </div>
      `
    : nothing;
  const showComposerInput = showComposer && props.disabledBanner?.kind !== "composer-replacement";
  if (!props.capabilityMenu) {
    state.capabilityMenuView = "root";
  }
  const disabledReasonId = paneDomId(props.paneId, "disabled-reason");
  const voiceError = showComposerInput
    ? renderChatVoiceError({
        status: props.realtimeTalkCameraError ? "error" : props.realtimeTalkStatus,
        detail: props.realtimeTalkDetail,
        onDismissError: props.realtimeTalkCameraError
          ? undefined
          : props.onDismissRealtimeTalkError,
      })
    : nothing;
  const composerAlerts =
    voiceError !== nothing
      ? html`<div class="agent-chat__composer-errors agent-chat__composer-errors--standalone">
          ${voiceError}
        </div>`
      : nothing;
  const offlineText = props.offline
    ? props.queuedOutboxCount
      ? t("chat.composer.offlineQueuedHint", { count: String(props.queuedOutboxCount) })
      : t("chat.composer.offlineHint")
    : null;
  const primaryComposerStatus = props.disabledReason
    ? {
        text: props.disabledReason,
        tone: props.disabledReasonTone ?? ("danger" as const),
        icon:
          (props.disabledReasonTone ?? "danger") === "danger"
            ? icons.alertTriangle
            : icons.shieldQuestion,
      }
    : state.dictationError
      ? { text: state.dictationError, tone: "danger" as const, icon: icons.alertTriangle }
      : offlineText
        ? { text: offlineText, tone: "warn" as const, icon: globeOffIcon }
        : null;
  const composerUnderlaps =
    showComposerInput && primaryComposerStatus
      ? html`<div class="agent-chat__composer-underlaps" data-tone=${primaryComposerStatus.tone}>
          <div
            id=${props.disabledReason ? disabledReasonId : nothing}
            class="agent-chat__composer-status-band"
            role=${primaryComposerStatus.tone === "danger" ? "alert" : "status"}
            aria-live="polite"
          >
            <span class="agent-chat__composer-status-icon" aria-hidden="true"
              >${primaryComposerStatus.icon}</span
            >
            <span class="agent-chat__composer-status-text">${primaryComposerStatus.text}</span>
          </div>
        </div>`
      : nothing;
  // Dictation previews at the captured selection. The textarea remains
  // read-only until stop commits the same insertion into the real draft.
  const dictationPreviewDraft = dictation?.active
    ? insertComposerDictation(
        state.dictationSelection?.value ?? visibleDraft,
        dictation.transcript,
        state.dictationSelection?.start ?? visibleDraft.length,
        state.dictationSelection?.end ?? visibleDraft.length,
      ).value
    : visibleDraft;
  const draftDirection = detectTextDirection(dictationPreviewDraft);
  const interruptedStatus = props.runError
    ? nothing
    : renderChatRunStatusIndicator(composerRunStatus);
  const fallbackStatus = renderFallbackIndicator(props.fallbackStatus);
  const compactionStatus = renderCompactionIndicator(props.compactionStatus);
  const progressCard = props.progressCard
    ? html`<div class="agent-chat__progress-float">
        ${renderSessionProgressCard(
          props.progressCard,
          "composer",
          props.onDismissProgressCard,
          activeSession?.status,
          activeSession?.startedAt,
          activeSession?.endedAt,
          props.progressCardHasActiveRun,
        )}
      </div>`
    : nothing;
  const queue = renderChatQueue({
    queue: props.queue,
    offline: props.offline,
    canAbort: showAbortableUi,
    onQueueRetry: props.connected && canCompose ? props.onQueueRetry : undefined,
    onQueueSteer: props.connected && canCompose ? props.onQueueSteer : undefined,
    // Reordering is local bookkeeping, so it stays available while offline —
    // exactly when a queue is long enough to need it.
    onQueueMove: props.onQueueMove,
    onQueueEdit: props.queuedEdit?.onEdit,
    onQueueEditChange: props.queuedEdit?.onEditChange,
    onQueueEditSubmit: props.queuedEdit?.onEditSubmit,
    onQueueEditCancel: props.queuedEdit?.onCancel,
    editingId: props.queuedEdit?.editingId ?? null,
    editingText: props.queuedEdit?.editingText,
    onQueueRemove: props.onQueueRemove,
  });
  const goalCard = activeSession?.goal
    ? html`<div class="agent-chat__goal-float">
        ${renderChatGoal(state, activeSession.goal, {
          canAct: props.connected && canCompose,
          onGoalCommand: props.onGoalCommand,
          onGoalEdit: (updatedGoal) => {
            commitComposerDraft(props, `/goal edit ${updatedGoal.objective}`);
            requestUpdate();
            queueMicrotask(() => state.composerTextarea?.focus({ preventScroll: true }));
          },
          requestUpdate,
        })}
      </div>`
    : nothing;
  const compoundQuestionComposer = Boolean(questionPanelProps && showComposerInput);
  return html`
    <div
      class="agent-chat__composer-shell ${compoundQuestionComposer
        ? "agent-chat__composer-shell--question-composer"
        : ""}"
    >
      <div class="agent-chat__composer-overlay">
        ${props.anchoredNotices ?? nothing} ${composerAlerts} ${fallbackStatus} ${compactionStatus}
        ${interruptedStatus === nothing
          ? nothing
          : html`<div class="agent-chat__composer-run-status">${interruptedStatus}</div>`}
      </div>
      ${questionPanelProps
        ? html`
            <div class="agent-chat__question-dock">
              <openclaw-chat-question-panel
                .props=${questionPanelProps}
              ></openclaw-chat-question-panel>
            </div>
          `
        : nothing}
      ${disabledBanner} ${progressCard} ${queue} ${goalCard}
      ${showComposerInput
        ? html`<div
            class="agent-chat__input agent-chat__input--chat agent-chat__input--mobile-toolbar ${props.offline
              ? "agent-chat__input--offline"
              : ""}${dictation?.active ? " agent-chat__input--dictating" : ""}"
            @wa-show=${handleChatComposerDropdownShow}
            @wa-after-show=${restorePointerOpenedChatComposerTrigger}
            @openclaw-composer-dismiss-invocations=${() => {
              state.slashMenuOpen = false;
              resetSlashMenuState(state);
              resetSkillMenuState(state);
              requestUpdate();
            }}
            @click=${(event: MouseEvent) => focusComposerFromChrome(event, canCompose)}
            @pointerdown=${(event: PointerEvent) => {
              markPointerOpenedChatComposerDropdown(event);
              focusComposerFromChrome(event, canCompose);
            }}
            ${ref(state.composerInputRef ?? undefined)}
          >
            ${slashMenuVisible
              ? renderSlashMenu(state, slashMenuHost, visibleDraft, requestUpdate)
              : nothing}
            ${skillMenuVisible ? renderSkillMenu(state, skillMenuHost, requestUpdate) : nothing}
            <div class="agent-chat__composer-lede">
              ${renderAttachmentPreview(props)}
              ${props.replyTarget
                ? html`
                    <div class="chat-reply-preview">
                      <span class="chat-reply-preview__icon">${icons.messageSquare}</span>
                      <span class="chat-reply-preview__label"
                        >${t("chat.messages.replyingTo", {
                          name: props.replyTarget.senderLabel ?? t("chat.messages.message"),
                        })}</span
                      >
                      <span class="chat-reply-preview__text"
                        >${truncateUtf16Safe(props.replyTarget.text, 120)}${props.replyTarget.text
                          .length > 120
                          ? "..."
                          : ""}</span
                      >
                      <button
                        type="button"
                        class="chat-reply-preview__dismiss"
                        @click=${() => props.onClearReply?.()}
                        aria-label=${t("chat.composer.cancelReply")}
                        title=${t("chat.composer.cancelReply")}
                      >
                        ${icons.x}
                      </button>
                    </div>
                  `
                : nothing}
              ${renderComposerDictationStatus(dictation)}
              ${renderChatAttachmentInputs({ ...props, disabled: !canCompose })}
              ${props.realtimeTalkVideoStream
                ? html`
                    <div class="agent-chat__video-preview">
                      <video
                        class=${mirrorCameraPreview
                          ? "agent-chat__video-preview-mirrored"
                          : nothing}
                        autoplay
                        .muted=${true}
                        playsinline
                        aria-label=${t("chat.composer.cameraPreview")}
                        ${ref((element) => {
                          if (element instanceof HTMLVideoElement) {
                            element.srcObject = props.realtimeTalkVideoStream ?? null;
                          }
                        })}
                      ></video>
                      ${props.realtimeTalkCameraDevices &&
                      props.realtimeTalkCameraDevices.length >= 2 &&
                      props.onSwitchRealtimeCamera
                        ? html`
                            <openclaw-tooltip
                              class="agent-chat__video-preview-switch-tooltip"
                              .content=${t("chat.composer.switchCamera")}
                            >
                              <button
                                type="button"
                                class="agent-chat__video-preview-switch"
                                aria-label=${t("chat.composer.switchCamera")}
                                ?disabled=${props.realtimeTalkVideoPending}
                                @click=${props.onSwitchRealtimeCamera}
                              >
                                ${icons.switchCamera}
                              </button>
                            </openclaw-tooltip>
                          `
                        : nothing}
                    </div>
                  `
                : nothing}
            </div>

            <div class="agent-chat__composer-input-row">
              <div class="agent-chat__composer-combobox">
                <textarea
                  ${ref(state.textareaRef ?? undefined)}
                  .value=${dictationPreviewDraft}
                  dir=${draftDirection}
                  ?disabled=${!canCompose}
                  ?readonly=${dictation?.locksComposer === true}
                  aria-autocomplete="list"
                  aria-controls=${ifDefined(
                    slashMenuVisible || skillMenuVisible ? slashMenuListboxId : undefined,
                  )}
                  aria-expanded=${ifDefined(
                    slashMenuVisible || skillMenuVisible ? "true" : undefined,
                  )}
                  aria-activedescendant=${ifDefined(activeSlashMenuOptionId ?? undefined)}
                  aria-describedby=${`${slashMenuAnnouncementId}${
                    props.disabledReason ? ` ${disabledReasonId}` : ""
                  }`}
                  aria-keyshortcuts=${sendShortcut === "enter"
                    ? "Enter"
                    : "Control+Enter Meta+Enter"}
                  @keydown=${handleKeyDown}
                  @beforeinput=${handleBeforeInput}
                  @input=${handleInput}
                  @select=${handleSelect}
                  @focus=${handleSelect}
                  @pointerup=${handleSelect}
                  @compositionstart=${(event: CompositionEvent) => {
                    state.composerComposing = true;
                    state.composingDraft = {
                      key: draftKey,
                      value: (event.target as HTMLTextAreaElement).value,
                    };
                  }}
                  @compositionend=${handleCompositionEnd}
                  @blur=${handleBlur}
                  @paste=${(event: ClipboardEvent) => {
                    if (canCompose && !props.suggestionComposer) {
                      handleChatAttachmentPaste(event, props);
                    }
                  }}
                  aria-label=${placeholder}
                  placeholder=${dictation?.active ? "" : placeholder}
                  rows="1"
                ></textarea>
                <span
                  id=${slashMenuAnnouncementId}
                  class="sr-only"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  >${activeSlashMenuOptionLabel}</span
                >
                <span
                  class="agent-chat__run-status-announcement sr-only"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  >${runStatusAnnouncement}</span
                >
              </div>
            </div>

            <div class="agent-chat__composer-footer">
              <div class="agent-chat__composer-lead agent-chat__composer-meta">
                ${renderChatComposerPlusMenu({
                  attachments: props,
                  capabilityMenu: props.capabilityMenu,
                  disabled: !canCompose || props.suggestionComposer === true,
                  open: state.capabilityMenuOpen,
                  view: state.capabilityMenuView,
                  toolOverrides: props.toolOverrides,
                  onOpenChange: (open) => {
                    state.capabilityMenuOpen = open;
                    if (!open) {
                      state.capabilityMenuView = "root";
                    }
                    requestUpdate();
                  },
                  onViewChange: (view) => {
                    state.capabilityMenuView = view;
                    requestUpdate();
                  },
                })}
                ${composerLeadControl}
              </div>
              <div class="agent-chat__composer-trail">
                <div class="agent-chat__composer-meta agent-chat__composer-context">
                  ${contextNotice}
                </div>
                ${composerControls !== nothing
                  ? html` <div class="agent-chat__composer-controls">${composerControls}</div> `
                  : nothing}
                <div class="agent-chat__composer-actions">
                  ${renderChatPrimaryActions(runControlsProps)}
                </div>
              </div>
            </div>
          </div> `
        : nothing}
      ${composerUnderlaps}
    </div>
  `;
}
