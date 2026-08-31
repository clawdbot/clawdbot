import type { GatewaySessionRow } from "../../api/types.ts";
import { accumulatedStreamText, advanceAccumulatedStreamText } from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import {
  isHiddenAssistantStreamText,
  shouldHideAssistantChatMessage,
} from "../../lib/chat/message-visibility.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { reconcileChatRunStartup } from "./chat-run-startup.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  getChatRunOwner,
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
  setChatRunOwner,
} from "./history-merge.ts";
import {
  adoptStartedChatRun,
  reconcileChatRunFromSessionRow,
  setChatRunError,
} from "./run-lifecycle.ts";
import {
  latestPersistedSteerBoundary,
  resolveCumulativeAssistantTail,
} from "./stream-causal-boundary.ts";
import { materializeVisibleStreamState } from "./stream-reconciliation.ts";
import { handleAgentEvent } from "./tool-stream.ts";

export function materializeVisibleAssistantStreamMessages(
  messages: unknown[],
  state: ChatState,
  opts: {
    includeCurrent?: boolean;
    requirePersistedTool?: boolean;
    replacementMessages?: unknown[];
    persistCommentary?: boolean;
  } = {},
): unknown[] {
  return materializeVisibleStreamState(messages, state, {
    ...opts,
    persistCommentary: opts.persistCommentary ?? persistsChatCommentary(state),
    isHiddenAssistantMessage: shouldHideAssistantChatMessage,
    isHiddenStreamText: isHiddenAssistantStreamText,
  });
}

export function persistsChatCommentary(state: ChatState): boolean {
  return state.settings?.chatPersistCommentary !== false;
}

function replayInFlightRunEvents(
  state: ChatState,
  run: NonNullable<ChatHistoryResult["inFlightRun"]>,
): void {
  if (state.chatRunId !== run.runId || !Array.isArray(run.events)) {
    return;
  }
  for (const event of run.events) {
    if (!event || event.runId !== run.runId) {
      continue;
    }
    // SAFETY: history replays the same agent events against the pane that owns live tool state.
    handleAgentEvent(state as never, event as never);
  }
}

function resolveInFlightAssistantText(bufferedText: unknown): string | null {
  return typeof bufferedText === "string" &&
    bufferedText &&
    !isHiddenAssistantStreamText(bufferedText)
    ? bufferedText
    : null;
}

function onlyInFlightRunProjectionChanged(
  previous: ReturnType<typeof getChatSessionProjection>["runs"],
  current: ReturnType<typeof getChatSessionProjection>["runs"],
  runId: string,
): boolean {
  for (const [previousRunId, run] of Object.entries(previous)) {
    if (previousRunId !== runId && current[previousRunId] !== run) {
      return false;
    }
  }
  for (const [currentRunId, run] of Object.entries(current)) {
    if (currentRunId !== runId && previous[currentRunId] !== run) {
      return false;
    }
  }
  return true;
}

function runProjectionsUnchanged(
  previous: ReturnType<typeof getChatSessionProjection>["runs"],
  current: ReturnType<typeof getChatSessionProjection>["runs"],
): boolean {
  const previousEntries = Object.entries(previous);
  return (
    previousEntries.length === Object.keys(current).length &&
    previousEntries.every(([runId, run]) => current[runId] === run)
  );
}

export function readRunProjections(state: ChatState, sessionKey: string, agentId?: string) {
  return getChatSessionProjection(
    state,
    state.chatMessages,
    readChatSessionProjectionScope(state, {
      sessionKey,
      ...(agentId ? { agentId } : {}),
    }),
  ).runs;
}

function mergeInFlightAssistantText(snapshot: string | null, live: string | null): string | null {
  if (!snapshot || live?.startsWith(snapshot)) {
    return live ?? snapshot;
  }
  if (!live || snapshot.startsWith(live)) {
    return snapshot;
  }
  // Divergence: live deltas are newer than the bounded snapshot, so the local
  // cumulative buffer wins — a lagging snapshot must not rewind streamed text.
  return live;
}

export function applyHistoryRun(params: {
  state: ChatState;
  run: ChatHistoryResult["inFlightRun"];
  sessionInfo: GatewaySessionRow | undefined;
  previousRunProjections: ReturnType<typeof getChatSessionProjection>["runs"];
  runProjectionsBeforeApply: ReturnType<typeof getChatSessionProjection>["runs"];
  currentRunProjections: ReturnType<typeof getChatSessionProjection>["runs"];
  resetStream: boolean;
  activeStreamBeforeReset: string | null;
}): void {
  const {
    state,
    run,
    sessionInfo,
    previousRunProjections,
    runProjectionsBeforeApply,
    currentRunProjections,
    resetStream,
    activeStreamBeforeReset,
  } = params;
  const inFlightRunId = run?.runId?.trim();
  if (!inFlightRunId || !run) {
    const terminalRunId = sessionInfo?.lastRunId;
    const knownRun = terminalRunId ? currentRunProjections[terminalRunId] : undefined;
    if (
      terminalRunId &&
      (sessionInfo.status === "done" ||
        sessionInfo.status === "failed" ||
        sessionInfo.status === "timeout") &&
      sessionInfo.hasActiveRun !== true &&
      !isSessionRunActive(sessionInfo) &&
      (!state.chatRunId || state.chatRunId === terminalRunId) &&
      !state.chatQueue.some(
        (item) =>
          item.sendState === "sending" && item.sendRunId && item.sendRunId !== terminalRunId,
      ) &&
      (!knownRun ||
        state.chatRunId === terminalRunId ||
        getChatRunOwner(state) === terminalRunId) &&
      runProjectionsUnchanged(previousRunProjections, runProjectionsBeforeApply)
    ) {
      // A copied row cannot reclaim retired display ownership. The pane retains
      // its accepted owner past active cleanup; unseen runs recover through the
      // reducer, whose full diagnostic wins over the bounded history summary.
      const projection = reduceChatSessionProjection(state, {
        type: "runTerminal",
        runId: terminalRunId,
        status:
          sessionInfo.status === "done"
            ? "completed"
            : sessionInfo.status === "timeout"
              ? "timeout"
              : "error",
        errorMessage: sessionInfo.lastRunError,
      });
      setChatRunOwner(state, terminalRunId);
      const terminal = projection.runs[terminalRunId];
      if (terminal?.errorMessage) {
        if (state.chatRunError?.runId !== terminalRunId || !knownRun?.errorMessage) {
          setChatRunError(state, terminal.errorMessage, terminalRunId);
        }
      } else if (
        terminal?.status === "completed" &&
        state.chatRunError?.runId &&
        state.chatRunError.runId !== terminalRunId
      ) {
        state.chatRunError = null;
      }
      reconcileChatRunFromSessionRow(state, sessionInfo, { publishRunStatus: false });
    }
    return;
  }
  const projectedInFlightRun = currentRunProjections[inFlightRunId];
  const sameRunContinued =
    state.chatRunId === inFlightRunId &&
    projectedInFlightRun?.status === "streaming" &&
    onlyInFlightRunProjectionChanged(previousRunProjections, currentRunProjections, inFlightRunId);
  const retainsLiveStream =
    sameRunContinued ||
    (state.chatRunId === inFlightRunId &&
      (activeStreamBeforeReset !== null ||
        state.chatStreamSegments?.some(
          (segment) => !segment.runId || segment.runId === inFlightRunId,
        )));
  const activeRunIds = sessionInfo?.activeRunIds;
  const inFlightRunIsActive =
    isSessionRunActive(sessionInfo ?? {}) &&
    (!Array.isArray(activeRunIds) || activeRunIds.includes(inFlightRunId)) &&
    (!projectedInFlightRun || projectedInFlightRun.status === "streaming");
  const canAdoptInFlightRun =
    inFlightRunIsActive &&
    ((resetStream &&
      !state.chatRunId &&
      runProjectionsUnchanged(previousRunProjections, runProjectionsBeforeApply)) ||
      sameRunContinued);
  if (canAdoptInFlightRun) {
    // Canonical run projections change on every live delta or terminal.
    // Their identity fences ABA races where a run starts and finishes while
    // history is pending; deltas from this same live run must still merge.
    adoptStartedChatRun(state, inFlightRunId, Date.now());
    state.chatRunSessionAbortable = run?.sessionAbortable === true;
  }
  if (!inFlightRunIsActive || state.chatRunId !== inFlightRunId) {
    return;
  }
  const snapshotStartedAt =
    typeof run.startedAt === "number" && Number.isFinite(run.startedAt) ? run.startedAt : null;
  const liveText = sameRunContinued
    ? mergeInFlightAssistantText(
        resolveInFlightAssistantText(extractText(projectedInFlightRun?.message)),
        activeStreamBeforeReset,
      )
    : activeStreamBeforeReset;
  state.chatStream = mergeInFlightAssistantText(resolveInFlightAssistantText(run.text), liveText);
  state.chatStreamStartedAt = snapshotStartedAt ?? state.chatStreamStartedAt ?? Date.now();
  // A retained pane gets its boundary from session.message. Only fresh adoption
  // reconstructs it from history, with the persisted prefix as cumulative evidence.
  const boundary = retainsLiveStream
    ? null
    : latestPersistedSteerBoundary(state.chatMessages, inFlightRunId);
  const tail =
    state.chatStream === null
      ? null
      : resolveCumulativeAssistantTail(
          state.chatMessages,
          state.chatStream,
          inFlightRunId,
          boundary?.index,
        );
  const prefix = state.chatStream?.slice(0, state.chatStream.length - (tail?.length ?? 0)) ?? "";
  const accumulated = accumulatedStreamText(state.chatStreamSegments ?? []);
  if (boundary || advanceAccumulatedStreamText(accumulated, prefix) !== accumulated) {
    state.chatStreamSegments = [
      ...(state.chatStreamSegments ?? []),
      {
        text: prefix,
        ts: state.chatStreamStartedAt,
        runId: inFlightRunId,
        ...(boundary ? { boundaryRunId: boundary.runId } : {}),
        ...(prefix ? { persisted: true } : { boundaryMarker: true }),
      },
    ];
  }
  const startup = run.events?.findLast(
    (event) => event.runId === inFlightRunId && event.stream === "run_status",
  );
  const startupPhase = startup?.data.phase;
  const hasStartupStatus =
    startupPhase === "preparing_workspace" ||
    startupPhase === "naming_worktree" ||
    startupPhase === "creating_worktree" ||
    startupPhase === "running_setup" ||
    startupPhase === "provisioning_environment" ||
    startupPhase === "preparing_context" ||
    startupPhase === "starting_model";
  if (run.text) {
    reconcileChatRunStartup(state, { state: "activity", runId: inFlightRunId });
  } else if (startup && hasStartupStatus) {
    reconcileChatRunStartup(state, {
      state: "status",
      runId: inFlightRunId,
      phase: startupPhase,
      seq: startup.seq,
    });
  }
  // Disconnect cleanup intentionally removes transient activity rows while
  // retaining the owned run. Replay fills that gap; per-identity sequence
  // fences keep a delayed snapshot from replacing newer live progress.
  replayInFlightRunEvents(state, run);
}
