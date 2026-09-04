import {
  isLocallyOptimisticSessionMessage,
  readSessionMessageSequence,
  type SessionProjectionState,
} from "../browser.js";
import type { ConversationArtifactStore } from "./conversation-artifacts.js";
import type { ConversationInteractionStore } from "./conversation-interactions.js";
import type { ConversationToolStore } from "./conversation-tools.js";
import type {
  ControlModelConversationHistory,
  ControlModelConversationSnapshot,
  ControlModelConversationStatus,
} from "./conversation-types.js";
import { cloneAndFreeze, hash, record, stableStringify, text } from "./conversation-utils.js";
import type { ControlModelConnectionSnapshot } from "./model.js";

export type ConversationTruncationState = {
  messages: boolean;
  runs: boolean;
};

type ConversationSnapshotInput = {
  sessionKey: string;
  status: ControlModelConversationStatus;
  revision: number;
  connection: ControlModelConnectionSnapshot;
  history: ControlModelConversationHistory;
  projection: SessionProjectionState;
  maxMessages: number;
  maxRuns: number;
  tools: ConversationToolStore;
  artifacts: ConversationArtifactStore;
  canMaterializeArtifacts: boolean;
  interactions: ConversationInteractionStore;
  partialReasons: Set<string>;
  truncation: ConversationTruncationState;
};

export function buildConversationSnapshot(
  input: ConversationSnapshotInput,
): ControlModelConversationSnapshot {
  const artifacts = input.artifacts.snapshot(input.projection.entries);
  const occurrence = new Map<string, number>();
  const messages = input.projection.entries.map((entry) => {
    const identity = entry.identity;
    const base = identity?.id
      ? `id:${identity.role}:${identity.id}`
      : identity?.externalSource
        ? `external:${identity.role}:${identity.externalSource}`
        : identity?.sequence !== null && identity?.sequence !== undefined
          ? `seq:${identity.role}:${identity.sequence}`
          : identity?.idempotencyKey
            ? `idem:${identity.role}:${identity.idempotencyKey}`
            : `content:${hash(stableStringify(entry.message))}`;
    const count = (occurrence.get(base) ?? 0) + 1;
    occurrence.set(base, count);
    return {
      key: `${base}:${count}`,
      role: identity?.role ?? text(record(entry.message)?.role) ?? "unknown",
      sequence: identity?.sequence ?? readSessionMessageSequence(entry.message),
      runId: entry.pending ? entry.pendingRunId : (identity?.runId ?? entry.pendingRunId),
      pending: entry.pending,
      live: entry.live,
      provisional: entry.pending || isLocallyOptimisticSessionMessage(entry.message),
      artifactIds: identity?.id
        ? artifacts
            .filter((artifact) => artifact.source.messageId === identity.id)
            .map((artifact) => artifact.id)
        : [],
      raw: cloneAndFreeze(entry.message),
    };
  });
  const visibleMessages =
    messages.length > input.maxMessages
      ? input.history.window === "older"
        ? messages.slice(0, input.maxMessages)
        : messages.slice(-input.maxMessages)
      : messages;
  if (messages.length > input.maxMessages) {
    input.truncation.messages = true;
  }
  const runs = Object.values(input.projection.runs).map((run) => {
    const snapshot: {
      runId: string;
      status: string;
      message?: unknown;
      stopReason?: string;
      errorKind?: string;
      errorMessage?: string;
    } = {
      runId: run.runId,
      status: run.status,
    };
    if (run.message !== undefined) {
      snapshot.message = cloneAndFreeze(run.message);
    }
    if (run.stopReason) {
      snapshot.stopReason = run.stopReason;
    }
    if (run.errorKind) {
      snapshot.errorKind = run.errorKind;
    }
    if (run.errorMessage) {
      snapshot.errorMessage = run.errorMessage;
    }
    return snapshot;
  });
  const activeRuns = runs.filter((run) => run.status === "streaming");
  const terminalRuns = runs.filter((run) => run.status !== "streaming");
  const activeWindow = activeRuns.slice(-input.maxRuns);
  const terminalSlots = input.maxRuns - activeWindow.length;
  const visibleRuns = [
    ...activeWindow,
    ...(terminalSlots > 0 ? terminalRuns.slice(-terminalSlots) : []),
  ];
  if (runs.length > input.maxRuns) {
    input.truncation.runs = true;
  }
  const tools = input.tools.snapshot((toolCallId) =>
    artifacts
      .filter((artifact) => artifact.source.toolCallId === toolCallId)
      .map((artifact) => artifact.id),
  );
  const approvals = input.interactions.approvalsSnapshot();
  const questions = input.interactions.questionsSnapshot();
  const activeRun = visibleRuns.find((run) => run.status === "streaming") ?? null;
  const stale = input.status === "stale" || input.connection.status !== "connected";
  return cloneAndFreeze({
    sessionKey: input.sessionKey,
    status: input.status,
    revision: input.revision,
    historyRevision: input.history.revision,
    connection: input.connection,
    history: input.history,
    messages: visibleMessages,
    runs: visibleRuns,
    activeRun,
    tools,
    artifacts,
    approvals,
    questions,
    partialReasons: [...input.partialReasons],
    stale,
    hasTransportGap: input.projection.hasTransportGap,
    commandAvailability: {
      send: !stale && input.status !== "disposed",
      abort: !stale && activeRun !== null,
      resolveApproval: !stale && approvals.some((approval) => approval.status === "pending"),
      answerQuestion: !stale && questions.some((question) => question.status === "pending"),
      cancelQuestion: !stale && questions.some((question) => question.status === "pending"),
      materializeView:
        !stale &&
        input.canMaterializeArtifacts &&
        artifacts.some((artifact) =>
          artifact.views.some((view) => view.availability === "deferred"),
        ),
    },
    bounds: {
      messagesTruncated: input.truncation.messages,
      runsTruncated: input.truncation.runs,
      toolsTruncated: input.tools.truncated,
      approvalsTruncated: input.interactions.approvalsTruncated,
      questionsTruncated: input.interactions.questionsTruncated,
      artifactsTruncated: input.artifacts.truncated,
    },
  });
}
