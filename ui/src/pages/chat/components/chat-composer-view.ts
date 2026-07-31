import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  countSessionToolOverrides,
  sessionToolOverrideNames,
} from "../../../lib/sessions/tool-overrides.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import type { ComposerDictationController } from "../composer-dictation.ts";
import {
  handleChatAttachmentPaste,
  renderAttachmentPreview,
  renderChatAttachmentInputs,
} from "./chat-attachments.ts";
import type { ChatRunControlsProps } from "./chat-composer-controls.ts";
import { renderChatPrimaryActions } from "./chat-composer-controls.ts";
import {
  disconnectQuestionDock,
  focusComposerFromChrome,
  observeQuestionDock,
} from "./chat-composer-dom.ts";
import { renderChatGoal } from "./chat-composer-goal.ts";
import { renderChatComposerPlusMenu } from "./chat-composer-plus-menu.ts";
import { renderChatQueue } from "./chat-composer-queue.ts";
import { renderSkillMenu } from "./chat-composer-skill-menu.ts";
import { renderSlashMenu } from "./chat-composer-slash-menu.ts";
import { commitComposerDraft } from "./chat-composer-state.ts";
import {
  renderChatRunStatusIndicator,
  renderCompactionIndicator,
  renderFallbackIndicator,
  type ComposerRunStatus,
} from "./chat-composer-status.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";
import { renderChatPlanChecklist } from "./chat-plan-checklist.ts";
import type { createGatewayQuestionPanelProps } from "./chat-question-card.ts";
import { renderChatVoiceError } from "./chat-voice-activity.ts";

type ChatComposerViewContext = {
  props: ChatComposerProps;
  state: ChatComposerState;
  canCompose: boolean;
  showAbortableUi: boolean;
  activeSession: GatewaySessionRow | undefined;
  visibleDraft: string;
  tokens: string | null;
  contextNotice: TemplateResult | typeof nothing;
  composerControls: TemplateResult | typeof nothing;
  runStatusAnnouncement: string;
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
  activeSlashMenuOptionId: string | null;
  activeSlashMenuOptionLabel: string;
  slashMenuListboxId: string;
  slashMenuAnnouncementId: string;
  composerRunStatus: ComposerRunStatus | null | undefined;
};

export function renderChatComposerView(context: ChatComposerViewContext) {
  const {
    props,
    state,
    canCompose,
    showAbortableUi,
    activeSession,
    visibleDraft,
    tokens,
    contextNotice,
    composerControls,
    runStatusAnnouncement,
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
    activeSlashMenuOptionId,
    activeSlashMenuOptionLabel,
    slashMenuListboxId,
    slashMenuAnnouncementId,
    composerRunStatus,
  } = context;
  let questionDock: HTMLElement | null = null;
  const disabledBanner = props.disabledBanner
    ? html`
        <div class="agent-chat__disabled-banner callout info callout--action" role="status">
          <span class="callout__content">${props.disabledBanner.text}</span>
          <button type="button" class="btn btn--xs" @click=${props.disabledBanner.onAction}>
            ${props.disabledBanner.actionLabel}
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
  const overrideCount = countSessionToolOverrides(props.toolOverrides);
  const overrideTooltip = sessionToolOverrideNames(
    props.toolOverrides,
    t("chat.composer.menu.webSearch"),
  ).join(", ");

  return html`
    ${renderChatQueue({
      queue: props.queue,
      canAbort: showAbortableUi,
      onQueueRetry: props.connected && canCompose ? props.onQueueRetry : undefined,
      onQueueSteer: props.connected && canCompose ? props.onQueueSteer : undefined,
      onQueueRemove: props.onQueueRemove,
    })}
    ${props.runError
      ? html`
          <div class="chat-run-error" role="alert">
            <span class="chat-run-error__icon" aria-hidden="true">${icons.alertTriangle}</span>
            <span class="chat-run-error__summary">${props.runError.summary}</span>
          </div>
        `
      : nothing}
    <div class="agent-chat__composer-shell">
      ${questionPanelProps
        ? html`
            <div
              class="agent-chat__question-dock"
              ${ref((element) => {
                const nextDock = element instanceof HTMLElement ? element : null;
                if (questionDock && questionDock !== nextDock) {
                  disconnectQuestionDock(questionDock);
                }
                questionDock = nextDock;
                if (questionDock) {
                  observeQuestionDock(questionDock);
                }
              })}
            >
              <openclaw-chat-question-panel
                .props=${questionPanelProps}
              ></openclaw-chat-question-panel>
            </div>
          `
        : nothing}
      ${disabledBanner}
      ${showComposerInput
        ? html`<div
            class="agent-chat__input ${props.offline ? "agent-chat__input--offline" : ""}"
            @click=${(event: MouseEvent) => focusComposerFromChrome(event, canCompose)}
          >
            ${props.offline
              ? html`<div class="agent-chat__offline-hint" role="status" aria-live="polite">
                  ${props.queuedOutboxCount
                    ? t("chat.composer.offlineQueuedHint", {
                        count: String(props.queuedOutboxCount),
                      })
                    : t("chat.composer.offlineHint")}
                </div>`
              : nothing}
            ${props.typingLabel
              ? html`<div class="agent-chat__typing-indicator" role="status">
                  ${props.typingLabel}
                </div>`
              : nothing}
            ${slashMenuVisible ? renderSlashMenu(requestUpdate, props, visibleDraft) : nothing}
            ${skillMenuVisible ? renderSkillMenu(requestUpdate, props) : nothing}
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
            <div class="agent-chat__composer-status-stack">
              ${dictation?.active
                ? html`
                    <div
                      class=${`agent-chat__dictation-status${dictation.finalizing ? " agent-chat__dictation-status--finalizing" : ""}`}
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      <span class="agent-chat__dictation-label"
                        >${dictation.finalizing
                          ? t("chat.composer.dictationFinalizing")
                          : dictation.connecting
                            ? t("chat.composer.dictationConnecting")
                            : t("chat.composer.dictationRecording", {
                                elapsed: dictation.elapsed,
                              })}</span
                      >
                      ${dictation.partial
                        ? html`<span class="agent-chat__dictation-partial"
                            >${dictation.partial}</span
                          >`
                        : nothing}
                    </div>
                  `
                : nothing}
              ${renderChatPlanChecklist(props.planStatus, {
                active: showAbortableUi,
                variant: "bar",
              })}
              ${renderFallbackIndicator(props.fallbackStatus)}
              ${renderCompactionIndicator(props.compactionStatus)}
              ${renderChatGoal(state, activeSession?.goal, {
                canAct: props.connected && canCompose,
                onGoalCommand: props.onGoalCommand,
                onGoalEdit: (goal) => {
                  commitComposerDraft(props, `/goal edit ${goal.objective}`);
                  requestUpdate();
                  queueMicrotask(() => state.composerTextarea?.focus({ preventScroll: true }));
                },
                requestUpdate,
              })}
            </div>

            ${renderChatAttachmentInputs({ ...props, disabled: !canCompose })}
            ${renderChatVoiceError({
              status: props.realtimeTalkCameraError ? "error" : props.realtimeTalkStatus,
              detail: props.realtimeTalkDetail,
              onDismissError: props.realtimeTalkCameraError
                ? undefined
                : props.onDismissRealtimeTalkError,
            })}
            ${props.realtimeTalkVideoStream
              ? html`
                  <div class="agent-chat__video-preview">
                    <video
                      class=${mirrorCameraPreview ? "agent-chat__video-preview-mirrored" : nothing}
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
            ${props.disabledReason
              ? html`
                  <div class="agent-chat__disabled-reason">
                    <span>${props.disabledReason}</span>
                  </div>
                `
              : nothing}

            <div class="agent-chat__composer-input-row">
              ${renderChatComposerPlusMenu({
                attachments: props,
                showCapabilities: props.capabilityMenu !== undefined,
                basePath: props.capabilityMenu?.basePath ?? "",
                disabled: !canCompose || props.suggestionComposer === true,
                open: state.capabilityMenuOpen,
                view: state.capabilityMenuView,
                toolOverrides: props.toolOverrides,
                skills: props.capabilityMenu?.skills ?? null,
                skillsLoading: props.capabilityMenu?.skillsLoading ?? false,
                skillsError: props.capabilityMenu?.skillsError ?? false,
                mcpServers: props.capabilityMenu?.mcpServers ?? [],
                toolsEffectiveResult: props.capabilityMenu?.toolsEffectiveResult ?? null,
                toolsEffectiveLoading: props.capabilityMenu?.toolsEffectiveLoading ?? false,
                toolsEffectiveError: props.capabilityMenu?.toolsEffectiveError ?? false,
                toolAccessMutationBlockedReason:
                  props.capabilityMenu?.toolAccessMutationBlockedReason ?? null,
                webSearchBaseEnabled: props.capabilityMenu?.webSearchBaseEnabled ?? true,
                mutationBlockedReason: props.capabilityMenu?.mutationBlockedReason ?? null,
                canAdmin: props.capabilityMenu?.canAdmin ?? false,
                adminBlockedReason: props.capabilityMenu?.adminBlockedReason ?? null,
                addServerDialog: props.capabilityMenu?.addServerDialog,
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
                onLoadSkills: props.capabilityMenu?.onLoadSkills ?? (() => {}),
                onPatchToolOverrides: props.capabilityMenu?.onPatchToolOverrides ?? (() => {}),
                onNavigate: props.capabilityMenu?.onNavigate ?? (() => {}),
                onAddServer: props.capabilityMenu?.onAddServer,
                onEnsureToolAccess: props.capabilityMenu?.onEnsureToolAccess,
                onOpenToolAccess: props.capabilityMenu?.onOpenToolAccess,
              })}
              <div class="agent-chat__composer-combobox">
                <textarea
                  ${ref(state.textareaRef ?? undefined)}
                  .value=${visibleDraft}
                  dir=${detectTextDirection(visibleDraft)}
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
                  aria-describedby=${slashMenuAnnouncementId}
                  aria-keyshortcuts=${sendShortcut === "enter"
                    ? "Enter"
                    : "Control+Enter Meta+Enter"}
                  @keydown=${handleKeyDown}
                  @beforeinput=${handleBeforeInput}
                  @input=${handleInput}
                  @select=${handleSelect}
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
                  placeholder=${placeholder}
                  rows="1"
                ></textarea>
                ${tokens
                  ? html`
                      <div class="agent-chat__token-row">
                        <span class="agent-chat__token-count">${tokens}</span>
                      </div>
                    `
                  : nothing}
                <span
                  id=${slashMenuAnnouncementId}
                  class="agent-chat__sr-only"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  >${activeSlashMenuOptionLabel}</span
                >
                <span
                  class="agent-chat__run-status-announcement agent-chat__sr-only"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  >${runStatusAnnouncement}</span
                >
              </div>
              <div class="agent-chat__composer-actions">
                ${renderChatPrimaryActions(runControlsProps)}
              </div>
            </div>

            <div class="agent-chat__composer-footer">
              ${composerControls !== nothing
                ? html`
                    <div class="agent-chat__composer-controls">
                      ${composerRunStatus?.phase === "interrupted"
                        ? html`
                            <div class="agent-chat__composer-run-status">
                              ${renderChatRunStatusIndicator(composerRunStatus)}
                            </div>
                          `
                        : nothing}
                      ${overrideCount > 0 && props.capabilityMenu
                        ? html`
                            <openclaw-tooltip .content=${overrideTooltip}>
                              <span class="agent-chat__session-overrides-pill">
                                <button
                                  type="button"
                                  class="agent-chat__session-overrides-open"
                                  @click=${() => {
                                    state.capabilityMenuView = "root";
                                    state.capabilityMenuOpen = true;
                                    requestUpdate();
                                  }}
                                >
                                  ${t(
                                    overrideCount === 1
                                      ? "chat.composer.overrides.countOne"
                                      : "chat.composer.overrides.count",
                                    { count: String(overrideCount) },
                                  )}
                                </button>
                                <button
                                  type="button"
                                  class="agent-chat__session-overrides-clear"
                                  aria-label=${t("chat.composer.overrides.clear")}
                                  title=${props.capabilityMenu.mutationBlockedReason ?? ""}
                                  ?disabled=${props.capabilityMenu.mutationBlockedReason !== null}
                                  @click=${(event: MouseEvent) => {
                                    event.stopPropagation();
                                    if (!props.capabilityMenu?.mutationBlockedReason) {
                                      props.capabilityMenu?.onPatchToolOverrides(null);
                                    }
                                  }}
                                >
                                  ${icons.x}
                                </button>
                              </span>
                            </openclaw-tooltip>
                          `
                        : nothing}
                      ${composerControls}
                    </div>
                  `
                : nothing}
              <div class="agent-chat__composer-meta">${contextNotice}</div>
            </div>
          </div>`
        : nothing}
    </div>
  `;
}
