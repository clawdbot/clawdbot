import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import type { ChatRunUiStatus } from "../run-lifecycle.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { clearGoalElapsedTimers } from "./chat-composer-goal.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

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

export function getChatComposerState(paneId: string): ChatComposerState {
  const existing = composerStates.get(paneId);
  if (existing) {
    return existing;
  }
  const state = createChatComposerState();
  composerStates.set(paneId, state);
  return state;
}

export function hasTerminalRunStatus(status: ChatRunUiStatus | null | undefined): boolean {
  return status?.phase === "done" || status?.phase === "interrupted";
}

export function isCurrentSessionSubmittedProgress(
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

export function composerDraftKey(
  props: Pick<ChatComposerProps, "currentAgentId" | "sessionKey">,
): string {
  return `${props.currentAgentId}\u0000${props.sessionKey}`;
}

export function commitComposerDraft(props: ChatComposerProps, value: string): void {
  if (props.getDraft?.() === value || props.draft === value) {
    return;
  }
  props.onDraftChange(value);
}

export function markComposerInputIntent(state: ChatComposerState, key: string): void {
  state.composerInputIntentKey = key;
}

export function consumeComposerInputIntent(state: ChatComposerState, key: string): boolean {
  if (state.composerInputIntentKey !== key) {
    return false;
  }
  state.composerInputIntentKey = null;
  return true;
}

export function clearPendingClearedSubmittedDraft(state: ChatComposerState, key: string): void {
  if (state.pendingClearedSubmittedDraft?.key === key) {
    state.pendingClearedSubmittedDraft = null;
  }
}

function isExplicitComposerInsertion(event: InputEvent): boolean {
  return event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop";
}

export function suppressStaleSubmittedDraftReplay(
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
  clearGoalElapsedTimers();
}
