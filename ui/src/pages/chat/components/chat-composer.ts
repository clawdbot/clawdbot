// Chat-owned composer, queue, status, context, and run controls.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { GatewaySessionRow, SessionGoal, SessionsListResult } from "../../../api/types.ts";
import { normalizeBasePath } from "../../../app-route-paths.ts";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import {
  loadSettings,
  normalizeChatSendShortcut,
  patchSettings,
  type ChatSendShortcut,
} from "../../../app/settings.ts";
import { icons, type IconName } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { syncDropdownItemRadio } from "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment, ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import {
  SLASH_COMMANDS,
  getHiddenCommandCount,
  getSlashCommandCategoryLabel,
  getSlashCommandCompletions,
  getSlashCommandDescription,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import type { ControlUiFollowUpMode } from "../../../lib/chat/follow-up-mode.ts";
import { formatCompactTokenCount, formatCost } from "../../../lib/format.ts";
import { isMonitoredAuthProvider } from "../../../lib/model-auth.ts";
import {
  collectProviderQuotaGroups,
  formatQuotaReset,
  type ProviderQuotaGroup,
  type ProviderUsageDisplayProps,
  type QuotaBudgetSummary,
  type QuotaLimitSummary,
} from "../../../lib/provider-quota-summary.ts";
import {
  formatGoalDetail,
  formatGoalElapsed,
  formatGoalStatusLabel,
  formatGoalUsage,
  goalElapsedMs,
} from "../../../lib/session-goal.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { ComposerDictationController, insertComposerDictation } from "../composer-dictation.ts";
import { exportChatMarkdown } from "../export.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "../input-history.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";
import {
  discoverRealtimeTalkInputs,
  type RealtimeTalkCameraDevice,
  type RealtimeTalkInputDevice,
} from "../realtime-talk-input.ts";
import type { RealtimeTalkLevelSignal } from "../realtime-talk-level.ts";
import type { RealtimeTalkStatus } from "../realtime-talk.ts";
import { CHAT_RUN_STATUS_TOAST_DURATION_MS, type ChatRunUiStatus } from "../run-lifecycle.ts";
import { isInflightSteer, isSteeredQueueItem } from "../steered-chip.ts";
import type { CompactionStatus, FallbackStatus, PlanStatus } from "../tool-stream.ts";
import {
  handleChatAttachmentPaste,
  isLargePastedTextAttachment,
  renderAttachmentPreview,
  renderChatAttachmentInputs,
  renderChatAttachmentMenu,
} from "./chat-attachments.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { renderChatPlanChecklist } from "./chat-plan-checklist.ts";
import { createGatewayQuestionPanelProps } from "./chat-question-card.ts";
import {
  renderChatVoiceError,
  renderMicrophoneActivity,
  voiceStatusLabel,
} from "./chat-voice-activity.ts";

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;
const CONTEXT_NOTICE_RATIO = 0.85;
const CONTEXT_COMPACT_RATIO = 0.9;
const COMPOSER_CHROME_INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "wa-dropdown",
  "[contenteditable='true']",
  "[role='button']",
  "[role='listbox']",
  "[role='option']",
].join(",");

type ChatComposerProps = {
  paneId: string;
  sessionKey: string;
  currentAgentId: string;
  connected: boolean;
  offline?: boolean;
  canSend: boolean;
  disabledReason: string | null;
  disabledBanner?: { text: string; actionLabel: string; onAction: () => void };
  runError?: { summary: string } | null;
  sending: boolean;
  canAbort?: boolean;
  runStatus?: ChatRunUiStatus | null;
  waitingApproval?: boolean;
  compactionStatus?: CompactionStatus | null;
  fallbackStatus?: FallbackStatus | null;
  planStatus?: PlanStatus | null;
  gatewayQuestionPrompts?: readonly QuestionPrompt[];
  messages: unknown[];
  stream: string | null;
  queue: ChatQueueItem[];
  draft: string;
  sessions: SessionsListResult | null;
  providerUsage?: ProviderUsageDisplayProps;
  assistantName: string;
  sendShortcut?: ChatSendShortcut;
  followUpMode?: ControlUiFollowUpMode;
  attachments?: ChatAttachment[];
  getAttachments?: () => ChatAttachment[];
  replyTarget?: {
    messageId: string;
    text: string;
    senderLabel?: string | null;
    sourceMessageId?: string | null;
  } | null;
  realtimeTalkActive?: boolean;
  realtimeTalkStatus?: RealtimeTalkStatus;
  realtimeTalkDetail?: string | null;
  realtimeTalkInputLevel?: RealtimeTalkLevelSignal;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  realtimeTalkVideoStream?: MediaStream | null;
  realtimeTalkCameraDevices?: RealtimeTalkCameraDevice[];
  realtimeTalkVideoCapable?: boolean;
  realtimeTalkVideoPending?: boolean;
  realtimeTalkCameraError?: boolean;
  gatewayClient?: GatewayBrowserClient | null;
  composerHoldToRecord?: boolean;
  composerControls?: TemplateResult | typeof nothing;
  getDraft?: () => string;
  onDraftChange: (next: string) => void;
  onRequestUpdate?: () => void;
  onHistoryKeydown?: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
  onSlashIntent?: () => void | Promise<void>;
  onSend: () => void;
  onCompact?: () => void | Promise<void>;
  onToggleRealtimeTalk?: () => void;
  onToggleRealtimeCamera?: () => void;
  onSwitchRealtimeCamera?: () => void;
  onDismissRealtimeTalkError?: () => void;
  onDictationError?: (message: string) => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onNewSession: () => void;
  onClearReply?: () => void;
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  onGoalCommand?: (command: string) => void;
  onGatewayQuestionChange?: () => void;
  onGatewayQuestionSubmit?: (id: string, answers: Record<string, string[]>) => void | Promise<void>;
  onGatewayQuestionSkip?: (id: string) => void | Promise<void>;
};

type PendingClearedSubmittedDraft = {
  key: string;
  value: string;
};

type ComposingDraft = {
  key: string;
  value: string;
};

type ChatComposerState = {
  slashMenuOpen: boolean;
  slashMenuItems: SlashCommandDef[];
  slashMenuIndex: number;
  slashMenuMode: "command" | "args";
  slashMenuCommand: SlashCommandDef | null;
  slashMenuArgItems: string[];
  slashMenuExpanded: boolean;
  slashCommandRefreshPending: boolean;
  composerComposing: boolean;
  composingDraft: ComposingDraft | null;
  composerInputIntentKey: string | null;
  pendingClearedSubmittedDraft: PendingClearedSubmittedDraft | null;
  goalExpandedId: string | null;
  activeGatewayQuestionId: string | null;
  gatewayQuestionCollapsed: boolean;
  questionTakeoverActive: boolean;
  restoreComposerFocus: boolean;
  composerTextarea: HTMLTextAreaElement | null;
  microphonePickerOpen: boolean;
  microphonePickerLoading: boolean;
  microphoneDevices: RealtimeTalkInputDevice[];
  microphoneWarning: string | null;
  microphoneDiscoveryRequest: number;
  // Stable Lit ref: an inline arrow would change identity per render and force
  // a layout re-measure of the textarea on every chat render, not just attach.
  textareaRef: ((element?: Element) => void) | null;
  dictation: ComposerDictationController | null;
  dictationDraftKey: string | null;
  dictationSelection: { start: number; end: number } | null;
};

function createChatComposerState(): ChatComposerState {
  return {
    slashMenuOpen: false,
    slashMenuItems: [],
    slashMenuIndex: 0,
    slashMenuMode: "command",
    slashMenuCommand: null,
    slashMenuArgItems: [],
    slashMenuExpanded: false,
    slashCommandRefreshPending: false,
    composerComposing: false,
    composingDraft: null,
    composerInputIntentKey: null,
    pendingClearedSubmittedDraft: null,
    goalExpandedId: null,
    activeGatewayQuestionId: null,
    gatewayQuestionCollapsed: false,
    questionTakeoverActive: false,
    restoreComposerFocus: false,
    composerTextarea: null,
    microphonePickerOpen: false,
    microphonePickerLoading: false,
    microphoneDevices: [],
    microphoneWarning: null,
    microphoneDiscoveryRequest: 0,
    textareaRef: null,
    dictation: null,
    dictationDraftKey: null,
    dictationSelection: null,
  };
}

const composerStates = new Map<string, ChatComposerState>();

function getChatComposerState(paneId: string): ChatComposerState {
  const existing = composerStates.get(paneId);
  if (existing) {
    return existing;
  }
  const state = createChatComposerState();
  composerStates.set(paneId, state);
  return state;
}

function hasTerminalRunStatus(status: ChatRunUiStatus | null | undefined): boolean {
  return status?.phase === "done" || status?.phase === "interrupted";
}

function isCurrentSessionSubmittedProgress(
  item: ChatQueueItem,
  sessionKey: string,
  status: ChatRunUiStatus | null | undefined,
): boolean {
  return (
    item.sessionKey === sessionKey &&
    !item.pendingRunId &&
    (item.sendState === "sending" || item.sendState === "waiting-model") &&
    (status == null || item.sendRunId !== status.runId)
  );
}

// Single source for "the agent is visibly working": drives both the thread's
// working spark and the composer's sr-only announcement. A fresh terminal
// toast masks stale abortable rows so neither surface flashes back to working.
export function isChatRunWorking(
  props: Pick<ChatComposerProps, "canAbort" | "onAbort" | "runStatus" | "queue" | "sessionKey">,
): boolean {
  const canAbort = Boolean(props.canAbort && props.onAbort);
  return (
    (canAbort && !hasTerminalRunStatus(props.runStatus)) ||
    props.queue.some((item) =>
      isCurrentSessionSubmittedProgress(item, props.sessionKey, props.runStatus),
    )
  );
}

function composerDraftKey(props: Pick<ChatComposerProps, "currentAgentId" | "sessionKey">): string {
  return `${props.currentAgentId}\u0000${props.sessionKey}`;
}

function commitComposerDraft(props: ChatComposerProps, value: string): void {
  if (props.getDraft?.() === value || props.draft === value) {
    return;
  }
  props.onDraftChange(value);
}

function markComposerInputIntent(state: ChatComposerState, key: string): void {
  state.composerInputIntentKey = key;
}

function consumeComposerInputIntent(state: ChatComposerState, key: string): boolean {
  if (state.composerInputIntentKey !== key) {
    return false;
  }
  state.composerInputIntentKey = null;
  return true;
}

function clearPendingClearedSubmittedDraft(state: ChatComposerState, key: string): void {
  if (state.pendingClearedSubmittedDraft?.key === key) {
    state.pendingClearedSubmittedDraft = null;
  }
}

function isExplicitComposerInsertion(event: InputEvent): boolean {
  return event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop";
}

function suppressStaleSubmittedDraftReplay(
  target: HTMLTextAreaElement,
  event: InputEvent,
  currentDraft: string,
  hasInputIntent: boolean,
  state: ChatComposerState,
): boolean {
  const pending = state.pendingClearedSubmittedDraft;
  if (!pending) {
    return false;
  }
  if (target.value !== pending.value || hasInputIntent || isExplicitComposerInsertion(event)) {
    return false;
  }

  target.value = currentDraft;
  adjustTextareaHeight(target);
  return true;
}

export function resetChatComposerState(paneId?: string) {
  if (paneId) {
    // Goal elapsed timers are keyed by element and cleaned up when their
    // element leaves the DOM, so a per-pane reset does not need to touch them.
    composerStates.get(paneId)?.dictation?.dispose();
    composerStates.delete(paneId);
    return;
  }
  for (const state of composerStates.values()) {
    state.dictation?.dispose();
  }
  composerStates.clear();
  for (const timer of goalElapsedTimers.values()) {
    clearInterval(timer);
  }
  goalElapsedTimers.clear();
}

type ComposerTextareaResizeObserverState = {
  observer: ResizeObserver;
  adjustmentFrame: number | null;
};

const composerTextareaResizeObservers = new WeakMap<
  HTMLTextAreaElement,
  ComposerTextareaResizeObserverState
>();
const questionDockResizeObservers = new WeakMap<HTMLElement, ResizeObserver>();

function updateTextareaOverflow(el: HTMLTextAreaElement) {
  el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
}

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  // Hide the browser's scrollbar while measuring; restore it only when the
  // final CSS-constrained height actually clips the draft.
  el.style.overflowY = "hidden";
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  updateTextareaOverflow(el);
}

function observeTextareaOverflow(el: HTMLTextAreaElement) {
  if (typeof ResizeObserver !== "function" || composerTextareaResizeObservers.has(el)) {
    return;
  }
  let width = el.getBoundingClientRect().width;
  const observer = new ResizeObserver(() => {
    const nextWidth = el.getBoundingClientRect().width;
    if (nextWidth !== width) {
      width = nextWidth;
      const state = composerTextareaResizeObservers.get(el);
      if (state && state.adjustmentFrame === null) {
        state.adjustmentFrame = requestAnimationFrame(() => {
          state.adjustmentFrame = null;
          if (composerTextareaResizeObservers.get(el) === state) {
            adjustTextareaHeight(el);
          }
        });
      }
      return;
    }
    updateTextareaOverflow(el);
  });
  observer.observe(el);
  composerTextareaResizeObservers.set(el, { observer, adjustmentFrame: null });
}

function disconnectTextareaOverflowObserver(el: HTMLTextAreaElement) {
  const state = composerTextareaResizeObservers.get(el);
  composerTextareaResizeObservers.delete(el);
  if (!state) {
    return;
  }
  state.observer.disconnect();
  if (state.adjustmentFrame !== null) {
    cancelAnimationFrame(state.adjustmentFrame);
  }
}

function syncQuestionDockHeight(el: HTMLElement): void {
  el.closest<HTMLElement>(".chat")?.style.setProperty(
    "--chat-question-dock-height",
    `${el.offsetHeight}px`,
  );
}

function observeQuestionDock(el: HTMLElement): void {
  syncQuestionDockHeight(el);
  if (typeof ResizeObserver !== "function" || questionDockResizeObservers.has(el)) {
    return;
  }
  const observer = new ResizeObserver(() => syncQuestionDockHeight(el));
  observer.observe(el);
  questionDockResizeObservers.set(el, observer);
}

function disconnectQuestionDock(el: HTMLElement): void {
  questionDockResizeObservers.get(el)?.disconnect();
  questionDockResizeObservers.delete(el);
  el.closest<HTMLElement>(".chat")?.style.removeProperty("--chat-question-dock-height");
}

function scheduleTextareaHeightAdjustment(el: HTMLTextAreaElement) {
  // Lit invokes ref callbacks before the textarea is connected and before its
  // controlled value is committed, so measure once the render has settled.
  queueMicrotask(() => {
    if (el.isConnected) {
      adjustTextareaHeight(el);
    }
  });
}

function focusComposerFromChrome(event: MouseEvent, connected: boolean) {
  if (!connected || event.defaultPrevented) {
    return;
  }
  const target = event.target;
  const currentTarget = event.currentTarget;
  if (!(target instanceof Element) || !(currentTarget instanceof HTMLElement)) {
    return;
  }
  if (target.closest(COMPOSER_CHROME_INTERACTIVE_SELECTOR)) {
    return;
  }
  currentTarget
    .querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
    ?.focus({ preventScroll: true });
}

function restoreHistoryCaret(target: HTMLTextAreaElement, direction: "up" | "down") {
  requestAnimationFrame(() => {
    if (document.activeElement !== target) {
      return;
    }
    adjustTextareaHeight(target);
    const caret = direction === "up" ? 0 : target.value.length;
    target.selectionStart = caret;
    target.selectionEnd = caret;
  });
}

const goalElapsedTimers = new Map<HTMLElement, ReturnType<typeof setInterval>>();

function clearGoalElapsedTimer(el: HTMLElement) {
  const timer = goalElapsedTimers.get(el);
  if (timer !== undefined) {
    clearInterval(timer);
    goalElapsedTimers.delete(el);
  }
}

// Ticks the elapsed span in place so an idle active goal does not force
// full chat re-renders every second.
function createGoalElapsedRef(goal: SessionGoal) {
  let bound: HTMLElement | null = null;
  return (element: Element | undefined) => {
    if (bound) {
      clearGoalElapsedTimer(bound);
      bound = null;
    }
    if (!(element instanceof HTMLElement) || goal.status !== "active") {
      return;
    }
    bound = element;
    const timer = setInterval(() => {
      // Tests and detached renders can drop the pill without a final ref call.
      if (!element.isConnected) {
        clearGoalElapsedTimer(element);
        return;
      }
      element.textContent = formatGoalElapsed(goalElapsedMs(goal, Date.now()));
    }, 1000);
    goalElapsedTimers.set(element, timer);
  };
}

type ChatGoalActions = {
  canAct: boolean;
  onGoalCommand?: (command: string) => void;
  onGoalEdit?: (goal: SessionGoal) => void;
  requestUpdate: () => void;
};

function renderChatGoalActionButton(options: {
  className: string;
  label: string;
  icon: TemplateResult;
  onClick: () => void;
}): TemplateResult {
  return html`
    <openclaw-tooltip content=${options.label}>
      <button
        class="agent-chat__goal-action ${options.className}"
        type="button"
        aria-label=${options.label}
        @click=${options.onClick}
      >
        ${options.icon}
      </button>
    </openclaw-tooltip>
  `;
}

function renderChatGoal(
  state: ChatComposerState,
  goal: SessionGoal | undefined,
  actions: ChatGoalActions,
): TemplateResult | typeof nothing {
  if (!goal) {
    return nothing;
  }
  const elapsed = formatGoalElapsed(goalElapsedMs(goal, Date.now()));
  const usage = formatGoalUsage(goal);
  const expanded = state.goalExpandedId === goal.id;
  const showActions = actions.canAct && Boolean(actions.onGoalCommand);
  const canResume =
    goal.status === "paused" ||
    goal.status === "blocked" ||
    goal.status === "usage_limited" ||
    goal.status === "budget_limited";
  const toggleExpanded = () => {
    state.goalExpandedId = expanded ? null : goal.id;
    actions.requestUpdate();
  };
  return html`
    <div
      class="agent-chat__goal agent-chat__goal--${goal.status}"
      role="group"
      aria-label=${formatGoalDetail(goal)}
    >
      <div class="agent-chat__goal-row">
        <span class="agent-chat__goal-icon">${icons.target}</span>
        <span class="agent-chat__goal-label">${formatGoalStatusLabel(goal.status)}</span>
        <span class="agent-chat__goal-objective">${goal.objective}</span>
        <span class="agent-chat__goal-elapsed" ${ref(createGoalElapsedRef(goal))}>${elapsed}</span>
        <span class="agent-chat__goal-actions">
          ${showActions && actions.onGoalEdit && goal.status !== "complete"
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-edit",
                label: t("chat.goals.edit"),
                icon: icons.penLine,
                onClick: () => actions.onGoalEdit?.(goal),
              })
            : nothing}
          ${showActions && goal.status === "active"
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-pause",
                label: t("chat.goals.pause"),
                icon: icons.pause,
                onClick: () => actions.onGoalCommand?.("/goal pause"),
              })
            : nothing}
          ${showActions && canResume
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-resume",
                label: t("chat.goals.resume"),
                icon: icons.play,
                onClick: () => actions.onGoalCommand?.("/goal resume"),
              })
            : nothing}
          ${showActions
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-clear",
                label: t("chat.goals.clear"),
                icon: icons.trash,
                onClick: () => actions.onGoalCommand?.("/goal clear"),
              })
            : nothing}
          <button
            class="agent-chat__goal-action agent-chat__goal-expand"
            type="button"
            aria-expanded=${expanded ? "true" : "false"}
            aria-label=${expanded ? "Hide goal details" : "Show goal details"}
            @click=${toggleExpanded}
          >
            ${expanded ? icons.chevronDown : icons.chevronRight}
          </button>
        </span>
      </div>
      ${expanded
        ? html`
            <div class="agent-chat__goal-detail">
              <div class="agent-chat__goal-detail-objective">${goal.objective}</div>
              ${goal.lastStatusNote
                ? html`<div class="agent-chat__goal-detail-note">${goal.lastStatusNote}</div>`
                : nothing}
              <div class="agent-chat__goal-detail-meta">
                ${usage ? `${usage} · ${elapsed}` : elapsed}
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

function resetSlashMenuState(state: ChatComposerState): void {
  state.slashMenuMode = "command";
  state.slashMenuCommand = null;
  state.slashMenuArgItems = [];
  state.slashMenuItems = [];
  state.slashMenuExpanded = false;
}

function hasVisibleSlashMenuState(state: ChatComposerState): boolean {
  return (
    state.slashMenuOpen ||
    state.slashMenuMode !== "command" ||
    state.slashMenuCommand !== null ||
    state.slashMenuArgItems.length > 0 ||
    state.slashMenuItems.length > 0 ||
    state.slashMenuExpanded
  );
}

function closeSlashMenuIfNeeded(state: ChatComposerState, requestUpdate: () => void): void {
  if (!hasVisibleSlashMenuState(state)) {
    return;
  }
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

function requestSlashCommandRefresh(
  value: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
  getCurrentValue?: () => string,
): void {
  const state = getChatComposerState(props.paneId);
  if (!props.onSlashIntent || state.slashCommandRefreshPending) {
    return;
  }
  const refresh = props.onSlashIntent();
  if (!refresh || typeof refresh.then !== "function") {
    return;
  }
  state.slashCommandRefreshPending = true;
  void Promise.resolve(refresh).finally(() => {
    state.slashCommandRefreshPending = false;
    const nextValue = getCurrentValue?.() ?? props.getDraft?.() ?? value;
    if (!nextValue.startsWith("/")) {
      closeSlashMenuIfNeeded(state, requestUpdate);
      return;
    }
    updateSlashMenu(nextValue, requestUpdate, props, { skipSlashIntent: true });
  });
}

function updateSlashMenu(
  value: string,
  requestUpdate: () => void,
  props: ChatComposerProps,
  opts: { skipSlashIntent?: boolean } = {},
  getCurrentValue?: () => string,
): void {
  const state = getChatComposerState(props.paneId);
  const argMatch = value.match(/^\/(\S+)\s(.*)$/);
  if (argMatch) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const cmdName = argMatch[1]?.toLowerCase();
    const argFilter = argMatch[2]?.toLowerCase();
    if (cmdName === undefined || argFilter === undefined) {
      closeSlashMenuIfNeeded(state, requestUpdate);
      return;
    }
    const cmd = SLASH_COMMANDS.find((entry) => entry.name === cmdName);
    if (cmd?.argOptions?.length) {
      const filtered = argFilter
        ? cmd.argOptions.filter((arg) => arg.toLowerCase().startsWith(argFilter))
        : cmd.argOptions;
      if (filtered.length > 0) {
        state.slashMenuMode = "args";
        state.slashMenuCommand = cmd;
        state.slashMenuArgItems = filtered;
        state.slashMenuOpen = true;
        state.slashMenuIndex = 0;
        state.slashMenuItems = [];
        requestUpdate();
        return;
      }
    }
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }

  const match = value.match(/^\/(\S*)$/);
  if (match) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const items = getSlashCommandCompletions(match[1] ?? "", {
      showAll: state.slashMenuExpanded,
    });
    state.slashMenuItems = items;
    state.slashMenuOpen = items.length > 0;
    state.slashMenuIndex = 0;
    state.slashMenuMode = "command";
    state.slashMenuCommand = null;
    state.slashMenuArgItems = [];
  } else {
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }
  requestUpdate();
}

function selectSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  const state = getChatComposerState(props.paneId);
  if (cmd.argOptions?.length) {
    commitComposerDraft(props, `/${cmd.name} `);
    state.slashMenuMode = "args";
    state.slashMenuCommand = cmd;
    state.slashMenuArgItems = cmd.argOptions;
    state.slashMenuOpen = true;
    state.slashMenuIndex = 0;
    state.slashMenuItems = [];
    requestUpdate();
    return;
  }

  if (cmd.executeLocal && !cmd.args) {
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    commitComposerDraft(props, `/${cmd.name}`);
    props.onSend();
  } else {
    commitComposerDraft(props, `/${cmd.name} `);
    closeSlashMenuIfNeeded(state, requestUpdate);
  }
}

function tabCompleteSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  const state = getChatComposerState(props.paneId);
  if (cmd.argOptions?.length) {
    commitComposerDraft(props, `/${cmd.name} `);
    state.slashMenuMode = "args";
    state.slashMenuCommand = cmd;
    state.slashMenuArgItems = cmd.argOptions;
    state.slashMenuOpen = true;
    state.slashMenuIndex = 0;
    state.slashMenuItems = [];
    requestUpdate();
    return;
  }
  commitComposerDraft(props, cmd.args ? `/${cmd.name} ` : `/${cmd.name}`);
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

function selectSlashArg(
  arg: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
  run: boolean,
) {
  const state = getChatComposerState(props.paneId);
  const cmdName = state.slashMenuCommand?.name ?? "";
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  commitComposerDraft(props, `/${cmdName} ${arg}`);
  if (run) {
    props.onSend();
  }
  requestUpdate();
}

function slashOptionIdSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "item"
  );
}

function paneDomId(paneId: string, suffix: string): string {
  return `chat-${encodeURIComponent(paneId)}-${suffix}`;
}

function getSlashCommandOptionId(paneId: string, cmd: SlashCommandDef): string {
  return paneDomId(paneId, `slash-option-command-${slashOptionIdSegment(cmd.name)}`);
}

function getSlashArgOptionId(paneId: string, commandName: string, arg: string): string {
  return paneDomId(
    paneId,
    `slash-option-arg-${slashOptionIdSegment(commandName)}-${slashOptionIdSegment(arg)}`,
  );
}

function isSlashMenuVisible(state: ChatComposerState): boolean {
  if (!state.slashMenuOpen) {
    return false;
  }
  if (state.slashMenuMode === "args") {
    return Boolean(state.slashMenuCommand && state.slashMenuArgItems.length > 0);
  }
  return state.slashMenuItems.length > 0;
}

function getActiveSlashMenuOptionId(state: ChatComposerState, paneId: string): string | null {
  if (!isSlashMenuVisible(state)) {
    return null;
  }
  if (state.slashMenuMode === "args") {
    const commandName = state.slashMenuCommand?.name;
    const arg = state.slashMenuArgItems[state.slashMenuIndex];
    return commandName && arg ? getSlashArgOptionId(paneId, commandName, arg) : null;
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  return cmd ? getSlashCommandOptionId(paneId, cmd) : null;
}

function getActiveSlashMenuOptionLabel(state: ChatComposerState): string {
  if (!isSlashMenuVisible(state)) {
    return "";
  }
  if (state.slashMenuMode === "args") {
    const commandName = state.slashMenuCommand?.name;
    const arg = state.slashMenuArgItems[state.slashMenuIndex];
    return commandName && arg ? `/${commandName} ${arg}` : "";
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  if (!cmd) {
    return "";
  }
  const command = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
  return `${command} ${getSlashCommandDescription(cmd)}`;
}

function scrollActiveSlashMenuOptionIntoView(state: ChatComposerState, paneId: string): void {
  const activeId = getActiveSlashMenuOptionId(state, paneId);
  if (!activeId) {
    return;
  }
  requestAnimationFrame(() => {
    const activeOption = document.getElementById(activeId);
    const menu = activeOption?.closest<HTMLElement>(".slash-menu");
    if (!activeOption || !menu) {
      return;
    }
    const menuBounds = menu.getBoundingClientRect();
    const optionBounds = activeOption.getBoundingClientRect();
    // scrollIntoView also moves the short-landscape composer and page. Keep
    // keyboard navigation owned by the menu so textarea focus stays stable.
    if (optionBounds.top < menuBounds.top) {
      menu.scrollTop -= menuBounds.top - optionBounds.top;
    } else if (optionBounds.bottom > menuBounds.bottom) {
      menu.scrollTop += optionBounds.bottom - menuBounds.bottom;
    }
  });
}

function renderSlashIcon(name: string) {
  return icons[name as IconName] ?? icons.terminal;
}

function tokenEstimate(draft: string): string | null {
  if (draft.length < 100) {
    return null;
  }
  return `~${Math.ceil(draft.length / 4)} tokens`;
}

function exportMarkdown(props: Pick<ChatComposerProps, "messages" | "assistantName">): void {
  exportChatMarkdown(props.messages, props.assistantName);
}

function renderSlashMenu(
  requestUpdate: () => void,
  props: ChatComposerProps,
  draft: string,
): TemplateResult | typeof nothing {
  const state = getChatComposerState(props.paneId);
  const listboxId = paneDomId(props.paneId, "slash-menu-listbox");
  if (!state.slashMenuOpen) {
    return nothing;
  }

  if (
    state.slashMenuMode === "args" &&
    state.slashMenuCommand &&
    state.slashMenuArgItems.length > 0
  ) {
    return html`
      <div
        id=${listboxId}
        class="slash-menu"
        role="listbox"
        aria-label=${t("chat.commands.arguments")}
      >
        <div class="slash-menu-group">
          <div class="slash-menu-group__label">
            /${state.slashMenuCommand.name} ${getSlashCommandDescription(state.slashMenuCommand)}
          </div>
          ${state.slashMenuArgItems.map(
            (arg, i) => html`
              <div
                id=${getSlashArgOptionId(props.paneId, state.slashMenuCommand?.name ?? "", arg)}
                class="slash-menu-item ${i === state.slashMenuIndex
                  ? "slash-menu-item--active"
                  : ""}"
                role="option"
                aria-selected=${i === state.slashMenuIndex}
                @click=${() => selectSlashArg(arg, props, requestUpdate, true)}
                @mouseenter=${() => {
                  state.slashMenuIndex = i;
                  requestUpdate();
                }}
              >
                ${state.slashMenuCommand?.icon
                  ? html`<span class="slash-menu-icon"
                      >${renderSlashIcon(state.slashMenuCommand.icon)}</span
                    >`
                  : nothing}
                <span class="slash-menu-name">${arg}</span>
                <span class="slash-menu-desc">/${state.slashMenuCommand?.name} ${arg}</span>
              </div>
            `,
          )}
        </div>
        <div class="slash-menu-footer">
          <kbd>↑↓</kbd> ${t("chat.commands.navigate")} <kbd>Tab</kbd> ${t("chat.commands.fill")}
          <kbd>Enter</kbd> ${t("chat.commands.run")} <kbd>Esc</kbd>
          ${t("chat.commands.close")}
        </div>
      </div>
    `;
  }

  if (state.slashMenuItems.length === 0) {
    return nothing;
  }

  const grouped = new Map<
    SlashCommandCategory,
    Array<{ cmd: SlashCommandDef; globalIdx: number }>
  >();
  for (const [i, cmd] of state.slashMenuItems.entries()) {
    const cat = cmd.category ?? "session";
    let list = grouped.get(cat);
    if (!list) {
      list = [];
      grouped.set(cat, list);
    }
    list.push({ cmd, globalIdx: i });
  }

  const sections: TemplateResult[] = [];
  for (const [cat, entries] of grouped) {
    sections.push(html`
      <div class="slash-menu-group">
        <div class="slash-menu-group__label">${getSlashCommandCategoryLabel(cat)}</div>
        ${entries.map(
          ({ cmd, globalIdx }) => html`
            <div
              id=${getSlashCommandOptionId(props.paneId, cmd)}
              class="slash-menu-item ${globalIdx === state.slashMenuIndex
                ? "slash-menu-item--active"
                : ""}"
              role="option"
              aria-selected=${globalIdx === state.slashMenuIndex}
              @click=${() => selectSlashCommand(cmd, props, requestUpdate)}
              @mouseenter=${() => {
                state.slashMenuIndex = globalIdx;
                requestUpdate();
              }}
            >
              ${cmd.icon
                ? html`<span class="slash-menu-icon">${renderSlashIcon(cmd.icon)}</span>`
                : nothing}
              <span class="slash-menu-name">/${cmd.name}</span>
              ${cmd.args ? html`<span class="slash-menu-args">${cmd.args}</span>` : nothing}
              <span class="slash-menu-desc">${getSlashCommandDescription(cmd)}</span>
              ${cmd.argOptions?.length
                ? html`<span class="slash-menu-badge"
                    >${t("chat.commands.optionCount", {
                      count: String(cmd.argOptions.length),
                    })}</span
                  >`
                : cmd.executeLocal && !cmd.args
                  ? html` <span class="slash-menu-badge">${t("chat.commands.instant")}</span> `
                  : nothing}
            </div>
          `,
        )}
      </div>
    `);
  }

  const hiddenCount = state.slashMenuExpanded ? 0 : getHiddenCommandCount();

  return html`
    <div id=${listboxId} class="slash-menu" role="listbox" aria-label=${t("chat.commands.menu")}>
      ${sections}
      ${hiddenCount > 0
        ? html`<button
            class="slash-menu-show-more"
            @click=${(event: Event) => {
              event.preventDefault();
              event.stopPropagation();
              state.slashMenuExpanded = true;
              updateSlashMenu(draft, requestUpdate, props);
            }}
          >
            ${hiddenCount === 1
              ? t("chat.commands.showMoreOne")
              : t("chat.commands.showMoreMany", { count: String(hiddenCount) })}
          </button>`
        : nothing}
      <div class="slash-menu-footer">
        <kbd>↑↓</kbd> ${t("chat.commands.navigate")} <kbd>Tab</kbd> ${t("chat.commands.fill")}
        <kbd>Enter</kbd> ${t("chat.commands.select")} <kbd>Esc</kbd>
        ${t("chat.commands.close")}
      </div>
    </div>
  `;
}

type ChatQueueProps = {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onQueueRemove: (id: string) => void;
};

function sendStateLabel(item: ChatQueueItem): string | null {
  if (isInflightSteer(item)) {
    return "Steering";
  }
  switch (item.sendState) {
    case "waiting-model":
      // Persisted state name predates reasoning and speed picker gating.
      return "Applying chat settings";
    case "waiting-idle":
      return "Waiting for current run";
    case "executing-command":
      return "Running command";
    case "waiting-reconnect":
      return "Waiting for reconnect";
    case "unconfirmed":
      return "Needs review";
    case "failed":
      return "Failed";
    default:
      return null;
  }
}

function renderChatQueue(props: ChatQueueProps) {
  const visibleQueue = props.queue.filter((item) => item.sendState !== "sending");
  if (!visibleQueue.length) {
    return nothing;
  }
  return html`
    <div class="chat-queue" role="status" aria-live="polite">
      ${visibleQueue.map((item) => renderChatQueueItem(item, props))}
    </div>
  `;
}

function renderChatQueueItem(item: ChatQueueItem, props: ChatQueueProps) {
  const stateLabel = sendStateLabel(item);
  const steered = isSteeredQueueItem(item);
  const failed = item.sendState === "failed" || item.sendState === "unconfirmed";
  const reconnecting = item.sendState === "waiting-reconnect";
  const busy = item.sendState === "executing-command" || isInflightSteer(item);
  const canSteer =
    Boolean(props.canAbort && props.onQueueSteer) &&
    !steered &&
    (item.sendState === undefined || item.sendState === "waiting-idle") &&
    !item.localCommandName;
  const text = item.text || (item.attachments?.length ? `Image (${item.attachments.length})` : "");
  const itemClass = `chat-queue__item${steered ? " chat-queue__item--steered" : ""}${
    failed ? " chat-queue__item--failed" : ""
  }${reconnecting ? " chat-queue__item--reconnect" : ""}`;
  // Row order keeps the actions on the first flex line; the error wraps below
  // them via flex-basis so failed rows grow by one line instead of a card.
  return html`
    <div class=${itemClass}>
      ${reconnecting
        ? html`<span class="chat-queue__dot" aria-hidden="true"></span>`
        : html`<span class="chat-queue__icon" aria-hidden="true">
            ${failed ? icons.alertTriangle : icons.clock}
          </span>`}
      ${renderChatAuthorAvatar(item.sender)}
      ${steered
        ? html`<span class="chat-queue__badge chat-queue__badge--steered"
            >${t("chat.queue.steered")}</span
          >`
        : nothing}
      ${stateLabel
        ? html`<span
            class="chat-queue__badge"
            title=${ifDefined(reconnecting ? item.sendError : undefined)}
            >${stateLabel}</span
          >`
        : nothing}
      <span class="chat-queue__text" title=${text}>${text}</span>
      <span class="chat-queue__actions">
        ${failed && props.onQueueRetry
          ? html`
              <button
                class="chat-queue__retry"
                type="button"
                aria-label=${t("chat.queue.retryQueuedMessage")}
                @click=${() => props.onQueueRetry?.(item.id)}
              >
                ${icons.refresh}
                <span>${t("chat.queue.retry")}</span>
              </button>
            `
          : nothing}
        ${canSteer
          ? html`
              <button
                class="chat-queue__steer"
                type="button"
                aria-label=${t("chat.queue.steerQueuedMessage")}
                @click=${() => props.onQueueSteer?.(item.id)}
              >
                ${icons.cornerDownRight}
                <span>${t("chat.queue.steer")}</span>
              </button>
            `
          : nothing}
        ${busy
          ? nothing
          : html`
              <openclaw-tooltip .content=${t("chat.queue.removeQueuedMessage")}>
                <button
                  class="chat-queue__remove"
                  type="button"
                  aria-label=${t("chat.queue.removeQueuedMessage")}
                  @click=${() => props.onQueueRemove(item.id)}
                >
                  ${icons.x}
                </button>
              </openclaw-tooltip>
            `}
      </span>
      ${
        // Reconnect rows auto-retry, so the raw transport error is noise there;
        // it stays inspectable via the badge tooltip. Failed/unconfirmed rows
        // keep the visible error because the user must act on them.
        item.sendError && !reconnecting
          ? html`<span class="chat-queue__error">${item.sendError}</span>`
          : nothing
      }
    </div>
  `;
}

type ComposerRunStatus =
  | ChatRunUiStatus
  | {
      phase: "in-progress";
      occurredAt?: number | null;
    };

// Working and Done need no composer chrome: the thread's working spark,
// content arriving, and Stop reverting to Send already show them (screen
// readers get the composer's persistent sr-only run-status region).
// Interrupted keeps a visible toast: the transcript shows nothing when a run
// is killed, so silence would read as "finished".
function renderChatRunStatusIndicator(status: ComposerRunStatus | null | undefined) {
  if (status?.phase !== "interrupted") {
    return nothing;
  }
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= CHAT_RUN_STATUS_TOAST_DURATION_MS) {
    return nothing;
  }
  const interrupted = t("chat.composer.runInterrupted");
  return html`
    <span
      class="agent-chat__run-status agent-chat__run-status--interrupted"
      aria-label=${t("chat.composer.runStatus", { status: interrupted })}
    >
      ${icons.stop}<span class="agent-chat__run-status-label">${interrupted}</span>
    </span>
  `;
}

function renderCompactionIndicator(status: CompactionStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  if (status.phase === "active" || status.phase === "retrying") {
    return html`
      <div
        class="compaction-indicator compaction-indicator--active"
        role="status"
        aria-live="polite"
      >
        ${icons.loader} Compacting context...
      </div>
    `;
  }
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div
          class="compaction-indicator compaction-indicator--complete"
          role="status"
          aria-live="polite"
        >
          ${icons.check} Context compacted
        </div>
      `;
    }
  }
  return nothing;
}

function renderFallbackIndicator(status: FallbackStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return nothing;
  }
  const details = [
    `Selected: ${status.selected}`,
    phase === "cleared" ? `Active: ${status.selected}` : `Active: ${status.active}`,
    phase === "cleared" && status.previous ? `Previous fallback: ${status.previous}` : null,
    status.reason ? `Reason: ${status.reason}` : null,
    status.attempts.length > 0 ? `Attempts: ${status.attempts.slice(0, 3).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? `Fallback cleared: ${status.selected}`
      : `Fallback active: ${status.active}`;
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? icons.check : icons.brain;
  return html`
    <openclaw-tooltip .content=${details}>
      <div class=${className} role="status" aria-live="polite" aria-label=${details}>
        ${icon} ${message}
      </div>
    </openclaw-tooltip>
  `;
}

type ContextNoticeOptions = {
  compactBusy?: boolean;
  compactDisabled?: boolean;
  messages?: unknown[];
  onCompact?: () => void | Promise<void>;
  providerUsage?: ProviderUsageDisplayProps;
};

type ProviderCostStats = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  provider: string | null;
  model: string | null;
};

function readCostRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readCostValue(
  cost: Record<string, unknown> | null,
  key: "input" | "output" | "cacheRead" | "cacheWrite",
) {
  const value = cost?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function latestProviderCostStats(messages: unknown[] | undefined): ProviderCostStats | null {
  if (!messages?.length) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = readCostRecord(messages[index]);
    if (message?.role === "user") {
      return null;
    }
    if (message?.role !== "assistant") {
      continue;
    }
    const directCost = readCostRecord(message.cost);
    const usageCost = readCostRecord(readCostRecord(message.usage)?.cost);
    const stats: ProviderCostStats = {
      provider: typeof message.provider === "string" ? message.provider.trim() || null : null,
      model:
        (typeof message.responseModel === "string" ? message.responseModel.trim() : "") ||
        (typeof message.model === "string" ? message.model.trim() : "") ||
        null,
    };
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const cost = readCostValue(directCost, key) ?? readCostValue(usageCost, key);
      if (cost !== undefined) {
        stats[key] = cost;
      }
    }
    if (
      [stats.input, stats.output, stats.cacheRead, stats.cacheWrite].some((value) => value != null)
    ) {
      return stats;
    }
  }
  return null;
}

function parseHexRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    return null;
  }
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

let cachedThemeNoticeColors: {
  warnHex: string;
  dangerHex: string;
  warnRgb: [number, number, number];
  dangerRgb: [number, number, number];
} | null = null;

function getThemeNoticeColors() {
  if (cachedThemeNoticeColors) {
    return cachedThemeNoticeColors;
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const warnHex = rootStyle.getPropertyValue("--warn").trim() || "#f59e0b";
  const dangerHex = rootStyle.getPropertyValue("--danger").trim() || "#ef4444";
  cachedThemeNoticeColors = {
    warnHex,
    dangerHex,
    warnRgb: parseHexRgb(warnHex) ?? [245, 158, 11],
    dangerRgb: parseHexRgb(dangerHex) ?? [239, 68, 68],
  };
  return cachedThemeNoticeColors;
}

function getContextNoticeViewModel(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
): {
  pct: number;
  used: number;
  limit: number;
  input: number | null;
  output: number | null;
  cost: number | null;
  provider: string | null;
  model: string | null;
  detail: string;
  color: string;
  bg: string;
  warning: boolean;
  compactRecommended: boolean;
  approximate: boolean;
} | null {
  const used = session?.totalTokens;
  const limit = session?.contextTokens ?? defaultContextTokens ?? 0;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || !limit) {
    return null;
  }
  const approximate = session?.totalTokensFresh === false;
  const ratio = used / limit;
  const pct = Math.min(Math.round(ratio * 100), 100);
  // A stale total is still useful orientation, but must not drive warning or
  // compaction decisions because the session may already have compacted.
  const warning = !approximate && ratio >= CONTEXT_NOTICE_RATIO;
  // Session rows expose the latest run snapshot; totalTokens is the separate context snapshot.
  const input = Number.isFinite(session?.inputTokens) ? (session?.inputTokens ?? null) : null;
  const output = Number.isFinite(session?.outputTokens) ? (session?.outputTokens ?? null) : null;
  const cost =
    typeof session?.estimatedCostUsd === "number" &&
    Number.isFinite(session.estimatedCostUsd) &&
    session.estimatedCostUsd >= 0
      ? session.estimatedCostUsd
      : null;
  const usage = {
    used,
    limit,
    input,
    output,
    cost,
    provider: session?.modelProvider?.trim() || null,
    model: session?.model?.trim() || null,
  };
  if (!warning) {
    return {
      pct,
      ...usage,
      detail: `${approximate ? "~" : ""}${formatCompactTokenCount(used)} / ${formatCompactTokenCount(limit)}`,
      color: "var(--muted)",
      bg: "color-mix(in srgb, var(--muted) 8%, transparent)",
      warning,
      compactRecommended: false,
      approximate,
    };
  }
  const { warnRgb, dangerRgb } = getThemeNoticeColors();
  const [wr, wg, wb] = warnRgb;
  const [dr, dg, db] = dangerRgb;
  const mix = Math.min(Math.max((ratio - 0.85) / 0.1, 0), 1);
  const r = Math.round(wr + (dr - wr) * mix);
  const g = Math.round(wg + (dg - wg) * mix);
  const b = Math.round(wb + (db - wb) * mix);
  const color = `rgb(${r}, ${g}, ${b})`;
  const bgOpacity = 0.08 + 0.08 * mix;
  const bg = `rgba(${r}, ${g}, ${b}, ${bgOpacity})`;
  return {
    pct,
    ...usage,
    detail: `${formatCompactTokenCount(used)} / ${formatCompactTokenCount(limit)}`,
    color,
    bg,
    warning,
    compactRecommended: ratio >= CONTEXT_COMPACT_RATIO,
    approximate,
  };
}

const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Provider window labels arrive as compact data strings ("5h", "Week"); model
// scoped labels (e.g. "Opus") pass through untranslated.
function formatUsageWindowLabel(label: string): string {
  if (label === "5h") {
    return t("chat.composer.contextUsage.limitFiveHour");
  }
  if (label === "Week") {
    return t("chat.composer.contextUsage.limitWeekly");
  }
  if (label === "Day") {
    return t("chat.composer.contextUsage.limitDaily");
  }
  const hours = /^(\d+)h$/.exec(label);
  if (hours) {
    return t("chat.composer.contextUsage.limitHours", { hours: hours[1] ?? "" });
  }
  return label;
}

function formatBudgetAmount(amount: number, unit: string): string {
  if (/^[A-Za-z]{3}$/.test(unit)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: unit.toUpperCase(),
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      // Non-ISO currency codes fall through to plain unit suffix formatting.
    }
  }
  return `${amount.toFixed(2)} ${unit}`;
}

function renderLimitBar(usedPercent: number, ariaLabel: string) {
  const severity = usedPercent >= 90 ? "danger" : usedPercent >= 75 ? "warn" : null;
  return html`
    <div
      class="context-usage__limit-bar"
      role="progressbar"
      aria-label=${ariaLabel}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${usedPercent}
    >
      <span
        class=${severity ? `context-usage__limit-fill--${severity}` : ""}
        style="width: ${usedPercent}%"
      ></span>
    </div>
  `;
}

function renderQuotaLimitRow(limit: QuotaLimitSummary) {
  const label = formatUsageWindowLabel(limit.label);
  const reset = formatQuotaReset(limit.resetAt);
  return html`
    <div class="context-usage__limit">
      <div class="context-usage__limit-head">
        <span class="context-usage__limit-label">${label}</span>
        <span class="context-usage__limit-meta">
          ${reset
            ? html`<span class="context-usage__limit-reset"
                >${t("chat.composer.contextUsage.resets", { time: reset })}</span
              >`
            : nothing}
          <strong>${limit.usedPercent}%</strong>
        </span>
      </div>
      ${renderLimitBar(limit.usedPercent, label)}
    </div>
  `;
}

function renderQuotaBudgetRow(budget: QuotaBudgetSummary) {
  const label = budget.label || t("chat.composer.contextUsage.usageCredits");
  const usedPercent = Math.max(0, Math.min(100, Math.round((budget.used / budget.limit) * 100)));
  const value = t("chat.composer.contextUsage.budgetValue", {
    used: formatBudgetAmount(budget.used, budget.unit),
    limit: formatBudgetAmount(budget.limit, budget.unit),
  });
  return html`
    <div class="context-usage__limit">
      <div class="context-usage__limit-head">
        <span class="context-usage__limit-label">${label}</span>
        <span class="context-usage__limit-meta"><strong>${value}</strong></span>
      </div>
      ${renderLimitBar(usedPercent, label)}
    </div>
  `;
}

function renderQuotaGroup(
  group: ProviderQuotaGroup,
  options: { usageHref: string; showProvider: boolean },
) {
  const heading = options.showProvider
    ? `${t("chat.composer.contextUsage.planUsage")} · ${group.displayName}`
    : t("chat.composer.contextUsage.planUsage");
  return html`
    <div class="context-usage__section-label context-usage__plan-header">
      <span>${heading}</span>
      <a
        class="context-usage__plan-link"
        href=${options.usageHref}
        data-chat-provider-usage="true"
        aria-label=${t("chat.composer.contextUsage.openUsage")}
      >
        ${group.plan ? html`<span class="context-usage__plan-badge">${group.plan}</span>` : nothing}
        ${icons.externalLink}
      </a>
    </div>
    ${group.accountEmail
      ? html`<div class="context-usage__account" data-chat-usage-account="true">
          ${group.accountEmail}
        </div>`
      : nothing}
    <div class="context-usage__limits">
      ${group.windows.map((limit) => renderQuotaLimitRow(limit))}
      ${group.budgets.map((budget) => renderQuotaBudgetRow(budget))}
    </div>
  `;
}

function renderContextNotice(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
  options: ContextNoticeOptions = {},
) {
  const model = getContextNoticeViewModel(session, defaultContextTokens);
  const quotaGroups = options.providerUsage
    ? collectProviderQuotaGroups(
        options.providerUsage.modelAuthStatusResult ?? null,
        isMonitoredAuthProvider,
      )
    : [];
  if (!model && quotaGroups.length === 0) {
    return nothing;
  }
  const canRenderCompact = Boolean(model?.compactRecommended && options.onCompact);
  const compactDisabled = options.compactDisabled === true || options.compactBusy === true;
  const summary = model
    ? t("chat.composer.contextUsage.summary", {
        used: `${model.approximate ? "~" : ""}${formatCompactTokenCount(model.used)}`,
        limit: formatCompactTokenCount(model.limit),
        pct: `${model.approximate ? "~" : ""}${model.pct}`,
      })
    : t("chat.usageRemaining");
  const percentage = model ? `${model.approximate ? "~" : ""}${model.pct}%` : null;
  const dashOffset = model ? RING_CIRCUMFERENCE * (1 - model.pct / 100) : RING_CIRCUMFERENCE;
  const providerCosts = model ? latestProviderCostStats(options.messages) : null;
  const provider = providerCosts?.provider ?? model?.provider;
  const responseModel = providerCosts?.model ?? model?.model;
  const sessionProviderKeys = new Set(
    [model?.provider, providerCosts?.provider]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.trim().toLowerCase()),
  );
  const currentGroup = quotaGroups.find((group) =>
    group.providers.some((id) => sessionProviderKeys.has(id.trim().toLowerCase())),
  );
  const planGroups = currentGroup
    ? [currentGroup, ...quotaGroups.filter((group) => group !== currentGroup)]
    : quotaGroups;
  // Plan-billed sessions hide dollar estimates: subscription usage is bounded
  // by the plan windows below, and per-token math would misread as real spend.
  // Billing mode is provider-level: session rows do not record which auth
  // profile served the run, so a provider with both an API key and a
  // subscription resolves to subscription display (per-run credential
  // attribution is #102807).
  const showCosts = !currentGroup;
  const usageHref = `${normalizeBasePath(options.providerUsage?.basePath ?? "")}/usage`;
  const formatStat = (value: number | null) =>
    value === null ? t("usage.common.emptyValue") : formatCompactTokenCount(value);
  const renderCostStat = (label: string, value: number | undefined) =>
    value === undefined
      ? nothing
      : html`
          <div>
            <dt>${label}</dt>
            <dd>${formatCost(value)}</dd>
          </div>
        `;
  return html`
    <div
      class="context-usage"
      style=${model ? `--ctx-color:${model.color};--ctx-bg:${model.bg}` : ""}
    >
      <details>
        <summary
          class="context-ring ${model?.warning ? "context-ring--warning" : ""}"
          aria-label=${summary}
          title=${t("chat.composer.contextUsage.open")}
        >
          <svg
            class="context-ring__dial"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
          >
            <circle class="context-ring__track" cx="8" cy="8" r=${RING_RADIUS} />
            <circle
              class="context-ring__fill"
              cx="8"
              cy="8"
              r=${RING_RADIUS}
              stroke-dasharray=${RING_CIRCUMFERENCE.toFixed(2)}
              stroke-dashoffset=${dashOffset.toFixed(2)}
            />
          </svg>
          ${percentage ? html`<span class="context-ring__pct">${percentage}</span>` : nothing}
        </summary>
        <section class="context-usage__popover" aria-label=${t("chat.composer.contextUsage.title")}>
          ${model
            ? html`
                <div class="context-usage__header">
                  <span class="context-usage__title"
                    >${t("chat.composer.contextUsage.contextWindow")}</span
                  >
                  <strong class="context-usage__context-value"
                    >${model.detail} · ${percentage}</strong
                  >
                </div>
                <div
                  class="context-usage__bar"
                  role="progressbar"
                  aria-label=${summary}
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-valuenow=${model.pct}
                >
                  <span style="width: ${model.pct}%"></span>
                </div>
              `
            : nothing}
          ${model
            ? html`
                <div class="context-usage__section-label">
                  ${t("chat.composer.contextUsage.latestRunTokens")}
                </div>
                <dl class="context-usage__stats">
                  <div>
                    <dt>${t("usage.breakdown.input")}</dt>
                    <dd>${formatStat(model.input)}</dd>
                  </div>
                  <div>
                    <dt>${t("usage.breakdown.output")}</dt>
                    <dd>${formatStat(model.output)}</dd>
                  </div>
                  ${!showCosts || model.cost === null
                    ? nothing
                    : html`
                        <div>
                          <dt>${t("chat.composer.contextUsage.estimatedCost")}</dt>
                          <dd>${formatCost(model.cost)}</dd>
                        </div>
                      `}
                </dl>
              `
            : nothing}
          ${showCosts && providerCosts
            ? html`
                <div class="context-usage__section-label">${t("usage.breakdown.costByType")}</div>
                <dl class="context-usage__stats context-usage__stats--cost">
                  ${renderCostStat(t("usage.breakdown.input"), providerCosts.input)}
                  ${renderCostStat(t("usage.breakdown.output"), providerCosts.output)}
                  ${renderCostStat(t("usage.breakdown.cacheRead"), providerCosts.cacheRead)}
                  ${renderCostStat(t("usage.breakdown.cacheWrite"), providerCosts.cacheWrite)}
                </dl>
              `
            : nothing}
          ${planGroups.map((group) =>
            renderQuotaGroup(group, {
              usageHref,
              showProvider: planGroups.length > 1,
            }),
          )}
          ${provider
            ? html`
                <div class="context-usage__model">
                  <span>${t("sessionsView.provider")}:</span>
                  <strong>${provider}</strong>
                </div>
              `
            : nothing}
          ${responseModel
            ? html`
                <div class="context-usage__model">
                  <span>${t("sessionsView.model")}:</span>
                  <strong>${responseModel}</strong>
                </div>
              `
            : nothing}
        </section>
      </details>
      ${canRenderCompact
        ? html`
            <button
              class="context-ring__action ${options.compactBusy
                ? "context-ring__action--busy"
                : ""}"
              type="button"
              aria-label=${t("chat.composer.compactRecommendedContext")}
              ?disabled=${compactDisabled}
              @click=${(event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                if (compactDisabled) {
                  return;
                }
                void options.onCompact?.();
              }}
            >
              ${options.compactBusy ? icons.loader : icons.minimize}
              <span>${options.compactBusy ? "Compacting" : "Compact"}</span>
            </button>
          `
        : nothing}
    </div>
  `;
}

type ChatRunControlsProps = {
  canAbort: boolean;
  canSend: boolean;
  connected: boolean;
  draft: string;
  hasAttachments?: boolean;
  hasMessages: boolean;
  isBusy: boolean;
  followUpMode?: ControlUiFollowUpMode;
  sending: boolean;
  voiceActive?: boolean;
  voiceStatus?: RealtimeTalkStatus;
  voiceDetail?: string | null;
  voiceInputLevel?: RealtimeTalkLevelSignal;
  voiceVideoCapable?: boolean;
  voiceVideoEnabled?: boolean;
  voiceVideoPending?: boolean;
  dictation?: ComposerDictationController;
  onDictationPointerDown?: (event: PointerEvent) => void;
  onAbort?: () => void;
  onExport: () => void;
  onNewSession: () => void;
  onSend: () => void;
  onStoreDraft: (draft: string) => void;
  onToggleVoice?: () => void;
  onToggleCamera?: () => void;
  microphonePicker?: TemplateResult | typeof nothing;
  showPrimary?: boolean;
  showSecondary?: boolean;
};

type MicrophonePickerProps = {
  devices: RealtimeTalkInputDevice[];
  loading: boolean;
  open: boolean;
  selectedDeviceId: string;
  voiceActive: boolean;
  warning: string | null;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (deviceId: string) => void;
};

function renderMicrophonePicker(props: MicrophonePickerProps) {
  // System default renders even while discovery runs: the dropdown's one-time
  // focus step needs at least one item or keyboard users never enter the menu.
  const options = props.loading
    ? [{ deviceId: "", label: t("chat.composer.systemDefaultMicrophone") }]
    : [{ deviceId: "", label: t("chat.composer.systemDefaultMicrophone") }, ...props.devices];
  const label = t("chat.composer.microphoneInput");
  return html`
    <wa-dropdown
      class="chat-talk-input-picker"
      placement="top-end"
      aria-label=${label}
      .open=${props.open}
      @wa-show=${props.onOpen}
      @wa-hide=${props.onClose}
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) =>
        props.onSelect(event.detail.item.value ?? "")}
    >
      <button
        slot="trigger"
        type="button"
        class="chat-talk-input-picker__trigger"
        aria-label=${label}
        aria-haspopup="menu"
        aria-expanded=${String(props.open)}
      >
        ${icons.chevronDown}
      </button>
      <div class="chat-talk-input-picker__heading">${label}</div>
      ${options.map((option) => {
        const selected = option.deviceId === props.selectedDeviceId;
        return html`
          <wa-dropdown-item
            class="chat-talk-input-picker__item"
            value=${option.deviceId}
            type="checkbox"
            role="menuitemradio"
            aria-checked=${String(selected)}
            ${ref((element) => syncDropdownItemRadio(element, selected))}
          >
            <span class="chat-talk-input-picker__label">${option.label}</span>
            <span slot="details" class="chat-talk-input-picker__check" aria-hidden="true"
              >${selected ? icons.check : nothing}</span
            >
          </wa-dropdown-item>
        `;
      })}
      ${props.loading
        ? html`<div class="chat-talk-input-picker__note" role="status">${t("common.loading")}</div>`
        : nothing}
      ${!props.loading && props.devices.length === 0
        ? html`<div class="chat-talk-input-picker__note">${t("chat.composer.noMicrophones")}</div>`
        : nothing}
      ${props.warning
        ? html`<div class="chat-talk-input-picker__warning" role="alert">${props.warning}</div>`
        : nothing}
      ${props.voiceActive
        ? html`<div class="chat-talk-input-picker__hint">
            ${t("chat.composer.microphoneAppliesNextSession")}
          </div>`
        : nothing}
    </wa-dropdown>
  `;
}

function renderComposerVoiceButton(props: ChatRunControlsProps) {
  const active = props.dictation?.active === true;
  const finalizing = props.dictation?.finalizing === true;
  const holding = props.dictation?.locksComposer === true;
  const label = finalizing
    ? t("chat.composer.dictationFinalizing")
    : active
      ? t("chat.composer.dictationReleaseToInsert")
      : t("chat.composer.startVoiceInput");
  // This shape owns pointer capture. Keep it stable while dictation rerenders,
  // or replacing the button releases capture and cancels the active hold.
  return html`
    <span class="chat-talk-control">
      <openclaw-tooltip .content=${label}>
        <button
          class=${active
            ? `chat-send-btn chat-send-btn--dictating${finalizing ? " chat-send-btn--dictation-finalizing" : ""}`
            : `chat-send-btn chat-send-btn--voice${props.dictation ? " chat-send-btn--hold-enabled" : ""}`}
          type="button"
          @pointerdown=${(event: PointerEvent) => props.onDictationPointerDown?.(event)}
          @click=${(event: MouseEvent) =>
            props.dictation ? props.dictation.handleClick(event) : props.onToggleVoice?.()}
          @contextmenu=${(event: MouseEvent) => props.dictation?.handleContextMenu(event)}
          ?disabled=${finalizing ||
          (!active && (!props.connected || props.sending || props.isBusy))}
          aria-label=${label}
        >
          ${finalizing
            ? icons.loader
            : active
              ? html`
                  ${renderMicrophoneActivity({
                    status: props.dictation?.connecting ? "connecting" : "listening",
                    inputLevel: props.dictation?.inputLevel,
                  })}
                  <span class="chat-send-btn__dictation-time">${props.dictation?.elapsed}</span>
                `
              : html`
                  ${icons.mic}
                  <span class="agent-chat__control-label">${label}</span>
                `}
        </button>
      </openclaw-tooltip>
      ${holding ? nothing : props.microphonePicker}
    </span>
  `;
}

function renderChatPrimaryActions(props: ChatRunControlsProps) {
  const hasComposedContent = Boolean(props.draft.trim() || props.hasAttachments);
  const steersActiveRun = props.followUpMode === "steer";
  const interruptsActiveRun = props.followUpMode === "interrupt";
  const activeRunActionLabel =
    props.followUpMode === undefined
      ? t("chat.runControls.send")
      : steersActiveRun
        ? t("chat.queue.steer")
        : interruptsActiveRun
          ? t("chat.runControls.send")
          : t("chat.runControls.queue");
  const activeRunActionDescription =
    props.followUpMode === undefined
      ? t("chat.runControls.sendMessage")
      : steersActiveRun
        ? t("chat.followUpModeSteer")
        : interruptsActiveRun
          ? t("chat.runControls.sendMessage")
          : t("chat.runControls.queueMessage");
  const storeDraftAndSend = () => {
    if (props.draft.trim()) {
      props.onStoreDraft(props.draft);
    }
    props.onSend();
  };
  const abortAction = props.canAbort
    ? html`
        <openclaw-tooltip .content=${t("chat.runControls.stop")}>
          <button
            class="chat-send-btn chat-send-btn--stop"
            @click=${props.onAbort}
            aria-label=${t("chat.runControls.stopGenerating")}
          >
            ${icons.stop}
            <span class="agent-chat__control-label">${t("chat.runControls.stop")}</span>
          </button>
        </openclaw-tooltip>
      `
    : nothing;

  // Transports keep the session active while reporting status "error"; the
  // alert row above the composer owns the error message, so the control keeps
  // only its stop affordance instead of a fake listening meter plus a
  // duplicate announcement.
  const voiceErrored = props.voiceStatus === "error";
  const voiceButton = renderComposerVoiceButton(props);
  const sendAction = html`
    <openclaw-tooltip
      .content=${props.isBusy ? t("chat.runControls.queue") : t("chat.runControls.send")}
    >
      <button
        class="chat-send-btn"
        @click=${storeDraftAndSend}
        ?disabled=${!props.canSend || props.sending}
        aria-label=${props.isBusy
          ? t("chat.runControls.queueMessage")
          : t("chat.runControls.sendMessage")}
      >
        ${icons.arrowUp}
        <span class="agent-chat__control-label"
          >${props.isBusy ? t("chat.runControls.queue") : t("chat.runControls.send")}</span
        >
      </button>
    </openclaw-tooltip>
  `;
  const dictationPrimaryAction = html`
    ${props.dictation?.active || !hasComposedContent ? nothing : sendAction} ${voiceButton}
  `;
  return html`
    ${props.voiceActive && props.onToggleVoice
      ? html`
          <span class="chat-talk-control chat-talk-control--active">
            <openclaw-tooltip .content=${t("chat.composer.stopVoiceInput")}>
              <button
                class="chat-send-btn chat-send-btn--voice-live${voiceErrored
                  ? " chat-send-btn--voice-error"
                  : ""}"
                @click=${props.onToggleVoice}
                aria-label=${t("chat.composer.stopVoiceInput")}
              >
                ${voiceErrored
                  ? nothing
                  : renderMicrophoneActivity({
                      status: props.voiceStatus,
                      inputLevel: props.voiceInputLevel,
                    })}
                <span class="chat-send-btn__voice-stop-glyph">${icons.stop}</span>
              </button>
            </openclaw-tooltip>
            ${props.microphonePicker}
          </span>
          ${voiceErrored
            ? nothing
            : html`
                <span
                  class="agent-chat__sr-only agent-chat__voice-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  >${voiceStatusLabel(props.voiceStatus, props.voiceDetail)}</span
                >
              `}
          ${props.voiceVideoCapable && props.onToggleCamera
            ? html`
                <openclaw-tooltip
                  .content=${props.voiceVideoEnabled
                    ? t("chat.composer.turnCameraOff")
                    : t("chat.composer.turnCameraOn")}
                >
                  <button
                    class="chat-send-btn chat-send-btn--voice"
                    @click=${props.onToggleCamera}
                    ?disabled=${props.voiceVideoPending ||
                    props.voiceStatus === "connecting" ||
                    props.voiceStatus === "error"}
                    aria-label=${props.voiceVideoEnabled
                      ? t("chat.composer.turnCameraOff")
                      : t("chat.composer.turnCameraOn")}
                    aria-pressed=${props.voiceVideoEnabled ? "true" : "false"}
                  >
                    ${props.voiceVideoEnabled ? icons.cameraOff : icons.camera}
                    <span class="agent-chat__control-label"
                      >${props.voiceVideoEnabled
                        ? t("chat.composer.turnCameraOff")
                        : t("chat.composer.turnCameraOn")}</span
                    >
                  </button>
                </openclaw-tooltip>
              `
            : nothing}
          ${abortAction}
        `
      : props.canAbort
        ? html`
            ${hasComposedContent
              ? html`
                  <openclaw-tooltip .content=${activeRunActionLabel}>
                    <button
                      class="chat-send-btn"
                      @click=${storeDraftAndSend}
                      ?disabled=${!props.canSend || props.sending}
                      aria-label=${activeRunActionDescription}
                    >
                      ${icons.arrowUp}
                      <span class="agent-chat__control-label">${activeRunActionLabel}</span>
                    </button>
                  </openclaw-tooltip>
                `
              : nothing}
            <openclaw-tooltip .content=${t("chat.runControls.stop")}>
              <button
                class="chat-send-btn chat-send-btn--stop"
                @click=${props.onAbort}
                aria-label=${t("chat.runControls.stopGenerating")}
              >
                ${icons.stop}
                <span class="agent-chat__control-label">${t("chat.runControls.stop")}</span>
              </button>
            </openclaw-tooltip>
          `
        : props.dictation
          ? dictationPrimaryAction
          : hasComposedContent || !props.onToggleVoice
            ? sendAction
            : voiceButton}
  `;
}

export function renderChatComposer(props: ChatComposerProps) {
  const state = getChatComposerState(props.paneId);
  const canCompose = props.canSend;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const hasTerminalStatus = hasTerminalRunStatus(props.runStatus);
  const showAbortableUi = canAbort && !hasTerminalStatus;
  const submittedProgress = props.queue.find((item) =>
    isCurrentSessionSubmittedProgress(item, props.sessionKey, props.runStatus),
  );
  const showSubmittedProgressUi = Boolean(submittedProgress);
  const composerRunStatus =
    showAbortableUi || showSubmittedProgressUi
      ? { phase: "in-progress" as const }
      : props.runStatus;
  const compactBusy =
    props.compactionStatus?.phase === "active" || props.compactionStatus?.phase === "retrying";
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const draftKey = composerDraftKey(props);
  if (state.dictationDraftKey !== null && state.dictationDraftKey !== draftKey) {
    state.dictation?.dispose();
    state.dictation = null;
    state.dictationSelection = null;
  }
  state.dictationDraftKey = draftKey;
  const visibleDraft =
    state.composingDraft?.key === draftKey ? state.composingDraft.value : props.draft;
  const actionDraft = visibleDraft;
  let questionDock: HTMLElement | null = null;
  state.textareaRef ??= (element?: Element) => {
    const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
    const prevTextarea = state.composerTextarea;
    if (prevTextarea && prevTextarea !== nextTextarea) {
      disconnectTextareaOverflowObserver(prevTextarea);
    }
    state.composerTextarea = nextTextarea;
    if (nextTextarea) {
      observeTextareaOverflow(nextTextarea);
      scheduleTextareaHeightAdjustment(nextTextarea);
      if (state.restoreComposerFocus) {
        state.restoreComposerFocus = false;
        queueMicrotask(() => state.composerTextarea?.focus({ preventScroll: true }));
      }
    }
  };
  // The stable ref only measures on attach, so programmatic draft swaps (send
  // clear, session switch, history restore) must re-measure explicitly.
  if (state.composerTextarea?.isConnected && state.composerTextarea.value !== visibleDraft) {
    scheduleTextareaHeightAdjustment(state.composerTextarea);
  }
  const hasVisualAttachments = (props.attachments ?? []).some(
    (attachment) => !isLargePastedTextAttachment(attachment),
  );
  const tokens = tokenEstimate(visibleDraft);
  const contextNotice = renderContextNotice(
    activeSession,
    props.sessions?.defaults?.contextTokens ?? null,
    {
      compactBusy,
      compactDisabled: !props.connected || !canCompose || isBusy || showAbortableUi,
      messages: props.messages,
      onCompact: props.onCompact,
      providerUsage: props.providerUsage,
    },
  );
  const composerControls = props.composerControls ?? nothing;
  const assistantName = props.assistantName || "OpenClaw";
  const inProgressLabel = props.waitingApproval
    ? t("chat.waitingForApproval")
    : submittedProgress?.sendState === "waiting-model"
      ? t("chat.composer.preparingModel")
      : props.stream !== null
        ? t("chat.composer.responding", { name: assistantName })
        : props.sending || submittedProgress
          ? t("chat.composer.sendingMessage")
          : t("chat.composer.working", { name: assistantName });
  // Persistent sr-only live region: run phases are otherwise conveyed only
  // visually (thread spark, content arriving, interrupted toast).
  const runStatusAnnouncement =
    composerRunStatus == null
      ? ""
      : composerRunStatus.phase === "in-progress"
        ? inProgressLabel
        : composerRunStatus.phase === "done"
          ? t("chat.composer.runDone")
          : t("chat.composer.runInterrupted");
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const sendShortcut = normalizeChatSendShortcut(props.sendShortcut);
  const gatewayQuestionPrompts =
    props.gatewayQuestionPrompts?.filter(
      (prompt) =>
        prompt.status === "pending" &&
        prompt.sessionKey !== undefined &&
        areUiSessionKeysEquivalent(prompt.sessionKey, props.sessionKey),
    ) ?? [];
  let gatewayQuestionIndex = gatewayQuestionPrompts.findIndex(
    (prompt) => prompt.id === state.activeGatewayQuestionId,
  );
  if (gatewayQuestionIndex < 0 && gatewayQuestionPrompts.length > 0) {
    gatewayQuestionIndex = 0;
    state.activeGatewayQuestionId = gatewayQuestionPrompts[0]?.id ?? null;
    state.gatewayQuestionCollapsed = false;
  } else if (gatewayQuestionPrompts.length === 0) {
    state.activeGatewayQuestionId = null;
    state.gatewayQuestionCollapsed = false;
  }
  const gatewayQuestionPrompt = gatewayQuestionPrompts[gatewayQuestionIndex];
  const selectGatewayQuestion = (index: number) => {
    const prompt = gatewayQuestionPrompts[index];
    if (!prompt) {
      return;
    }
    state.activeGatewayQuestionId = prompt.id;
    state.gatewayQuestionCollapsed = false;
    requestUpdate();
  };
  const questionPanelProps = gatewayQuestionPrompt
    ? createGatewayQuestionPanelProps(gatewayQuestionPrompt, {
        nowMs: Date.now(),
        collapsed: state.gatewayQuestionCollapsed,
        onCollapsedChange: (collapsed) => {
          state.gatewayQuestionCollapsed = collapsed;
          state.restoreComposerFocus = collapsed;
          requestUpdate();
        },
        onChange: props.onGatewayQuestionChange,
        onSubmit: props.onGatewayQuestionSubmit
          ? (answers) => props.onGatewayQuestionSubmit?.(gatewayQuestionPrompt.id, answers)
          : undefined,
        onSkip: props.onGatewayQuestionSkip
          ? () => props.onGatewayQuestionSkip?.(gatewayQuestionPrompt.id)
          : undefined,
        requestPosition:
          gatewayQuestionPrompts.length > 1
            ? { current: gatewayQuestionIndex + 1, total: gatewayQuestionPrompts.length }
            : undefined,
        onPreviousRequest: () =>
          selectGatewayQuestion(
            (gatewayQuestionIndex - 1 + gatewayQuestionPrompts.length) %
              gatewayQuestionPrompts.length,
          ),
        onNextRequest: () =>
          selectGatewayQuestion((gatewayQuestionIndex + 1) % gatewayQuestionPrompts.length),
      })
    : null;
  const questionTakeoverActive = Boolean(questionPanelProps && !state.gatewayQuestionCollapsed);
  if (!state.questionTakeoverActive && questionTakeoverActive) {
    // A question can arrive mid-IME composition before compositionend commits the host draft.
    // Commit before unmounting so the detached input cannot leave a stale shadow behind.
    if (state.composingDraft?.key === draftKey) {
      commitComposerDraft(props, state.composingDraft.value);
      state.composingDraft = null;
    }
    state.composerComposing = false;
  }
  if (state.questionTakeoverActive && !questionTakeoverActive) {
    state.restoreComposerFocus = true;
  }
  state.questionTakeoverActive = questionTakeoverActive;
  const showComposer = !questionTakeoverActive;

  const placeholder =
    !canCompose && props.disabledReason
      ? props.disabledReason
      : hasVisualAttachments
        ? t("chat.composer.placeholderWithAttachments")
        : t("chat.composer.placeholder", { name: props.assistantName || "agent" });

  // Offline text and attachments may enter the persisted reconnect queue, but
  // slash commands are live controls and must not execute against stale state.
  const canSubmitDraft = (draft: string) =>
    canCompose && (props.connected || !draft.trimStart().startsWith("/"));

  const syncComposerDraftAfterSend = (target: HTMLTextAreaElement | null) => {
    const submittedDraft = target?.value ?? props.getDraft?.() ?? props.draft;
    const hostDraft = props.getDraft?.() ?? props.draft;
    const clearedSubmittedDraft =
      hostDraft === "" && submittedDraft !== "" && target?.value === submittedDraft;
    if (clearedSubmittedDraft) {
      state.pendingClearedSubmittedDraft = {
        key: draftKey,
        value: submittedDraft,
      };
    } else {
      clearPendingClearedSubmittedDraft(state, draftKey);
    }
    if (target && target.value !== hostDraft) {
      target.value = hostDraft;
      adjustTextareaHeight(target);
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (state.composerComposing || event.isComposing || event.keyCode === 229) {
      return;
    }

    if (
      props.connected &&
      state.slashMenuOpen &&
      state.slashMenuMode === "args" &&
      state.slashMenuArgItems.length > 0
    ) {
      const len = state.slashMenuArgItems.length;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          state.slashMenuIndex = (state.slashMenuIndex + 1) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView(state, props.paneId);
          return;
        case "ArrowUp":
          event.preventDefault();
          state.slashMenuIndex = (state.slashMenuIndex - 1 + len) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView(state, props.paneId);
          return;
        case "Tab":
          event.preventDefault();
          {
            const arg = state.slashMenuArgItems[state.slashMenuIndex];
            if (arg !== undefined) {
              selectSlashArg(arg, props, requestUpdate, false);
            }
          }
          return;
        case "Enter":
          event.preventDefault();
          {
            const arg = state.slashMenuArgItems[state.slashMenuIndex];
            if (arg !== undefined) {
              selectSlashArg(arg, props, requestUpdate, true);
            }
          }
          return;
        case "Escape":
          event.preventDefault();
          state.slashMenuOpen = false;
          resetSlashMenuState(state);
          requestUpdate();
          return;
      }
    }

    if (props.connected && state.slashMenuOpen && state.slashMenuItems.length > 0) {
      const len = state.slashMenuItems.length;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          state.slashMenuIndex = (state.slashMenuIndex + 1) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView(state, props.paneId);
          return;
        case "ArrowUp":
          event.preventDefault();
          state.slashMenuIndex = (state.slashMenuIndex - 1 + len) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView(state, props.paneId);
          return;
        case "Tab":
          event.preventDefault();
          {
            const command = state.slashMenuItems[state.slashMenuIndex];
            if (command) {
              tabCompleteSlashCommand(command, props, requestUpdate);
            }
          }
          return;
        case "Enter":
          event.preventDefault();
          {
            const command = state.slashMenuItems[state.slashMenuIndex];
            if (command) {
              selectSlashCommand(command, props, requestUpdate);
            }
          }
          return;
        case "Escape":
          event.preventDefault();
          state.slashMenuOpen = false;
          resetSlashMenuState(state);
          requestUpdate();
          return;
      }
    }

    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && props.onHistoryKeydown) {
      const target = event.target as HTMLTextAreaElement;
      commitComposerDraft(props, target.value);
      const result = props.onHistoryKeydown({
        key: event.key,
        selectionStart: target.selectionStart,
        selectionEnd: target.selectionEnd,
        valueLength: target.value.length,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
      });
      if (result.handled) {
        if (result.preventDefault) {
          event.preventDefault();
        }
        // History navigation updates the renderer-owned draft outside a
        // reactive property; commit it before placing the caret in the DOM.
        requestUpdate();
        if (result.restoreCaret) {
          restoreHistoryCaret(target, result.restoreCaret);
        }
        return;
      }
    }

    const sendShortcutMatches = sendShortcut === "enter" || event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && !event.shiftKey && sendShortcutMatches) {
      if (!canSubmitDraft((event.target as HTMLTextAreaElement).value)) {
        return;
      }
      event.preventDefault();
      const target = event.target as HTMLTextAreaElement;
      commitComposerDraft(props, target.value);
      props.onSend();
      syncComposerDraftAfterSend(target);
    }
  };

  const syncComposerValue = (target: HTMLTextAreaElement) => {
    adjustTextareaHeight(target);
    commitComposerDraft(props, target.value);
    updateSlashMenu(target.value, requestUpdate, props, {}, () => target.value);
    requestUpdate();
  };
  const handleBeforeInput = (event: InputEvent) => {
    if (!state.composerComposing && !event.isComposing) {
      markComposerInputIntent(state, composerDraftKey(props));
    }
  };
  const handleInput = (event: InputEvent) => {
    const target = event.target as HTMLTextAreaElement;
    const hasInputIntent = consumeComposerInputIntent(state, draftKey);
    if (state.composerComposing || event.isComposing) {
      state.composingDraft = { key: draftKey, value: target.value };
      requestUpdate();
      return;
    }
    if (state.composingDraft?.key === draftKey) {
      state.composingDraft = null;
    }
    if (
      suppressStaleSubmittedDraftReplay(
        target,
        event,
        props.getDraft?.() ?? props.draft,
        hasInputIntent,
        state,
      )
    ) {
      return;
    }
    syncComposerValue(target);
  };
  const handleCompositionEnd = (event: CompositionEvent) => {
    state.composerComposing = false;
    if (state.composingDraft?.key === draftKey) {
      state.composingDraft = null;
    }
    syncComposerValue(event.target as HTMLTextAreaElement);
  };
  const handleBlur = (event: FocusEvent) => {
    const target = event.target as HTMLTextAreaElement;
    if (state.composingDraft?.key === draftKey) {
      state.composingDraft = null;
    }
    commitComposerDraft(props, target.value);
  };
  const handleSend = () => {
    const draft = state.composerTextarea?.value ?? props.draft;
    if (!canSubmitDraft(draft)) {
      return;
    }
    commitComposerDraft(props, draft);
    props.onSend();
    syncComposerDraftAfterSend(state.composerTextarea);
  };
  const handleVoicePrimaryAction = () => {
    if (props.realtimeTalkActive) {
      props.onToggleRealtimeTalk?.();
      return;
    }
    const liveDraft = state.composerTextarea?.value ?? visibleDraft;
    if (liveDraft.trim() || props.attachments?.length) {
      handleSend();
      return;
    }
    props.onToggleRealtimeTalk?.();
  };
  const openMicrophonePicker = () => {
    if (state.microphonePickerOpen) {
      return;
    }
    state.microphonePickerOpen = true;
    state.microphonePickerLoading = true;
    state.microphoneWarning = null;
    const request = ++state.microphoneDiscoveryRequest;
    requestUpdate();
    void discoverRealtimeTalkInputs(true)
      .then((result) => {
        if (request !== state.microphoneDiscoveryRequest) {
          return;
        }
        state.microphoneDevices = result.devices;
        state.microphoneWarning = result.warning;
      })
      .catch((error: unknown) => {
        if (request !== state.microphoneDiscoveryRequest) {
          return;
        }
        state.microphoneDevices = [];
        state.microphoneWarning =
          error instanceof Error ? error.message : t("chat.composer.microphoneAccessFailed");
      })
      .finally(() => {
        if (request !== state.microphoneDiscoveryRequest) {
          return;
        }
        state.microphonePickerLoading = false;
        requestUpdate();
      });
  };
  const closeMicrophonePicker = () => {
    if (!state.microphonePickerOpen) {
      return;
    }
    state.microphonePickerOpen = false;
    requestUpdate();
  };
  const selectMicrophone = (deviceId: string) => {
    patchSettings({ realtimeTalkInputDeviceId: deviceId.trim() || undefined });
    state.microphonePickerOpen = false;
    requestUpdate();
  };
  const selectedMicrophoneId = loadSettings().realtimeTalkInputDeviceId?.trim() ?? "";
  const microphonePicker = props.onToggleRealtimeTalk
    ? renderMicrophonePicker({
        devices: state.microphoneDevices,
        loading: state.microphonePickerLoading,
        open: state.microphonePickerOpen,
        selectedDeviceId: selectedMicrophoneId,
        voiceActive: Boolean(props.realtimeTalkActive),
        warning: state.microphoneWarning,
        onOpen: openMicrophonePicker,
        onClose: closeMicrophonePicker,
        onSelect: selectMicrophone,
      })
    : nothing;
  const dictationOptions = {
    client: props.gatewayClient ?? null,
    connected: props.connected,
    enabled: props.composerHoldToRecord !== false,
    realtimeTalkActive: props.realtimeTalkActive === true,
    onCommit: (transcript: string) => {
      const target = state.composerTextarea;
      const selection = state.dictationSelection ?? {
        start: target?.selectionStart ?? visibleDraft.length,
        end: target?.selectionEnd ?? visibleDraft.length,
      };
      const currentDraft = target?.value ?? props.getDraft?.() ?? props.draft;
      const insertion = insertComposerDictation(
        currentDraft,
        transcript,
        selection.start,
        selection.end,
      );
      if (target) {
        target.value = insertion.value;
        adjustTextareaHeight(target);
      }
      commitComposerDraft(props, insertion.value);
      state.dictationSelection = null;
      requestUpdate();
      queueMicrotask(() => {
        const textarea = state.composerTextarea;
        if (!textarea) {
          return;
        }
        textarea.focus({ preventScroll: true });
        textarea.selectionStart = insertion.caret;
        textarea.selectionEnd = insertion.caret;
      });
    },
    onError: (message: string) => props.onDictationError?.(message),
    onStateChange: requestUpdate,
    // With an initial empty composer, this button retains the existing
    // send-after-typing behavior until the host rerenders the primary actions.
    // Once a draft is rendered, the separate voice control starts Talk directly.
    onTap:
      actionDraft.trim() || props.attachments?.length
        ? () => props.onToggleRealtimeTalk?.()
        : handleVoicePrimaryAction,
  };
  state.dictation ??= new ComposerDictationController(dictationOptions);
  state.dictation.update(dictationOptions);
  const dictation =
    props.onToggleRealtimeTalk && props.composerHoldToRecord !== false
      ? state.dictation
      : undefined;
  const handleDictationPointerDown = (event: PointerEvent) => {
    const target = state.composerTextarea;
    state.dictationSelection = {
      start: target?.selectionStart ?? visibleDraft.length,
      end: target?.selectionEnd ?? visibleDraft.length,
    };
    if (dictation?.handlePointerDown(event) && target) {
      target.readOnly = true;
    }
  };
  const runControlsProps: ChatRunControlsProps = {
    canAbort: showAbortableUi,
    canSend: canSubmitDraft(actionDraft),
    connected: props.connected,
    draft: actionDraft,
    hasAttachments: Boolean(props.attachments?.length),
    hasMessages: props.messages.length > 0,
    isBusy,
    followUpMode: props.followUpMode,
    sending: props.sending,
    voiceActive: props.realtimeTalkActive,
    voiceStatus: props.realtimeTalkStatus,
    voiceDetail: props.realtimeTalkDetail,
    voiceInputLevel: props.realtimeTalkInputLevel,
    voiceVideoCapable: props.realtimeTalkVideoCapable,
    voiceVideoEnabled: Boolean(props.realtimeTalkVideoStream),
    voiceVideoPending: props.realtimeTalkVideoPending,
    onAbort: props.onAbort,
    onExport: () => exportMarkdown(props),
    onNewSession: props.onNewSession,
    onSend: handleSend,
    onStoreDraft: () => {},
    onToggleVoice: props.onToggleRealtimeTalk ? handleVoicePrimaryAction : undefined,
    onToggleCamera: props.onToggleRealtimeCamera,
    microphonePicker,
    dictation,
    onDictationPointerDown: handleDictationPointerDown,
  };
  const cameraFacingMode = props.realtimeTalkVideoStream
    ?.getVideoTracks?.()[0]
    ?.getSettings?.().facingMode;
  const mirrorCameraPreview = cameraFacingMode !== "environment";
  const slashMenuVisible = props.connected && canCompose && isSlashMenuVisible(state);
  const activeSlashMenuOptionId = getActiveSlashMenuOptionId(state, props.paneId);
  const activeSlashMenuOptionLabel = getActiveSlashMenuOptionLabel(state);
  const slashMenuListboxId = paneDomId(props.paneId, "slash-menu-listbox");
  const slashMenuAnnouncementId = paneDomId(props.paneId, "slash-active-announcement");

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
      ${props.disabledBanner
        ? html`
            <div class="agent-chat__disabled-banner callout info callout--action" role="status">
              <span class="callout__content">${props.disabledBanner.text}</span>
              <button type="button" class="btn btn--xs" @click=${props.disabledBanner.onAction}>
                ${props.disabledBanner.actionLabel}
              </button>
            </div>
          `
        : nothing}
      ${showComposer
        ? html`<div
            class="agent-chat__input ${props.offline ? "agent-chat__input--offline" : ""}"
            @click=${(event: MouseEvent) => focusComposerFromChrome(event, canCompose)}
          >
            ${props.offline
              ? html`<div class="agent-chat__offline-hint" role="status" aria-live="polite">
                  ${t("chat.composer.offlineHint")}
                </div>`
              : nothing}
            ${slashMenuVisible ? renderSlashMenu(requestUpdate, props, visibleDraft) : nothing}
            ${renderAttachmentPreview(props)}
            ${props.replyTarget
              ? html`
                  <div class="chat-reply-preview">
                    <span class="chat-reply-preview__icon">${icons.messageSquare}</span>
                    <span class="chat-reply-preview__label"
                      >Replying to ${props.replyTarget.senderLabel ?? "message"}</span
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
              ${renderChatAttachmentMenu({ ...props, disabled: !canCompose })}
              <div class="agent-chat__composer-combobox">
                <textarea
                  ${ref(state.textareaRef)}
                  .value=${visibleDraft}
                  dir=${detectTextDirection(visibleDraft)}
                  ?disabled=${!canCompose}
                  ?readonly=${dictation?.locksComposer === true}
                  aria-autocomplete="list"
                  aria-controls=${ifDefined(slashMenuVisible ? slashMenuListboxId : undefined)}
                  aria-activedescendant=${ifDefined(activeSlashMenuOptionId ?? undefined)}
                  aria-describedby=${slashMenuAnnouncementId}
                  aria-keyshortcuts=${sendShortcut === "enter"
                    ? "Enter"
                    : "Control+Enter Meta+Enter"}
                  @keydown=${handleKeyDown}
                  @beforeinput=${handleBeforeInput}
                  @input=${handleInput}
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
                    if (canCompose) {
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
