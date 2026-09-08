import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import {
  applySessionEntryReplacements,
  persistSessionTranscriptTurn,
  type SessionTranscriptTurnLifecyclePatch,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import {
  hasInterSessionUserProvenance,
  isCompletionReportInputProvenance,
} from "../../sessions/input-provenance.js";
import { buildRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.js";
import { isAnnounceRunId } from "../announce-idempotency.js";
import {
  getTranscriptMessageRole as getMessageRole,
  isTerminalSilentAssistantMessage,
  readTerminalSourceReplyDeliveryMirror,
} from "../embedded-agent-runner/message-visibility.js";
import { buildMainSessionRecoveryClearPatch } from "./main-session-recovery-clear.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import { isRestartAbortTailArtifact } from "./main-session-restart-recovery-resume-policy.js";
import {
  mainSessionRecoveryLog,
  resolveRestartRecoveryTerminalClientRunId,
} from "./main-session-restart-recovery-shared.js";

export function hasOnlyAnnounceRecoveryRuns(entry: SessionEntry): boolean {
  const runs = entry.restartRecoveryRuns;
  return Boolean(runs?.length && runs.every((run) => isAnnounceRunId(run.runId)));
}

export function hasCompletionReportUserTail(messages: readonly unknown[]): boolean {
  const message = messages.findLast((candidate) => getMessageRole(candidate) === "user");
  if (!message || typeof message !== "object") {
    return false;
  }
  const userMessage = message as { role?: unknown; provenance?: unknown };
  return (
    hasInterSessionUserProvenance(userMessage) &&
    isCompletionReportInputProvenance(userMessage.provenance)
  );
}

export async function reconcileInterruptedCompletionReport(
  params: MainSessionRecoveryStoreTarget & {
    entry: SessionEntry;
    source: "announce_runs" | "transcript";
  },
): Promise<{ outcome: "reconciled" } | { outcome: "changed"; entry: SessionEntry | null }> {
  let didReconcile = false;
  const current = await updateSessionEntry(
    params,
    (entry) => {
      const hasRecoveryRuns = Boolean(entry.restartRecoveryRuns?.length);
      const stillMatchesSource =
        params.source === "announce_runs" ? hasOnlyAnnounceRecoveryRuns(entry) : !hasRecoveryRuns;
      if (
        entry.sessionId !== params.entry.sessionId ||
        entry.status !== "running" ||
        entry.abortedLastRun !== true ||
        !stillMatchesSource
      ) {
        return null;
      }
      didReconcile = true;
      const endedAt = Date.now();
      return {
        ...buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: false }),
        ...buildMainSessionRecoveryClearPatch(entry),
        status: "killed",
        lifecycleRunId: undefined,
        lastRunId: resolveRestartRecoveryTerminalClientRunId(entry),
        abortedLastRun: false,
        endedAt,
        lastRunError: undefined,
        runtimeMs:
          typeof entry.startedAt === "number" ? Math.max(0, endedAt - entry.startedAt) : undefined,
        updatedAt: endedAt,
      };
    },
    { requireWriteSuccess: true },
  );
  if (didReconcile) {
    mainSessionRecoveryLog.info(
      `reconciled interrupted completion report to non-running: ${params.sessionKey}`,
    );
    return { outcome: "reconciled" };
  }
  return { outcome: "changed", entry: current };
}

function findSourceTurnRange(params: {
  continuationRunId?: string;
  messages: readonly unknown[];
  sourceTurnId: string;
}): { startIndex: number; endIndex: number } | undefined {
  const sourceUserTurnId = buildRunUserTurnIdempotencyKey(params.sourceTurnId);
  const sourceTurnIds = new Set([params.sourceTurnId, sourceUserTurnId]);
  const continuationTurnId = params.continuationRunId
    ? buildRunUserTurnIdempotencyKey(params.continuationRunId)
    : undefined;
  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index];
    if (
      getMessageRole(message) === "user" &&
      message &&
      typeof message === "object" &&
      sourceTurnIds.has(
        normalizeOptionalString((message as { idempotencyKey?: unknown }).idempotencyKey) ?? "",
      )
    ) {
      let endIndex = params.messages.length;
      for (let nextIndex = index + 1; nextIndex < params.messages.length; nextIndex += 1) {
        const nextMessage = params.messages[nextIndex];
        if (getMessageRole(nextMessage) !== "user") {
          continue;
        }
        const nextIdempotencyKey =
          nextMessage && typeof nextMessage === "object"
            ? normalizeOptionalString((nextMessage as { idempotencyKey?: unknown }).idempotencyKey)
            : undefined;
        // Late media and the exact restart continuation extend the same logical source turn.
        if (
          nextIdempotencyKey === `${params.sourceTurnId}:late-media` ||
          nextIdempotencyKey === continuationTurnId ||
          (continuationTurnId !== undefined &&
            nextIdempotencyKey === `${continuationTurnId}:late-media`)
        ) {
          continue;
        }
        endIndex = nextIndex;
        break;
      }
      return { startIndex: index, endIndex };
    }
  }
  return undefined;
}

function readToolCallId(message: Record<string, unknown>): string | undefined {
  return [
    message.toolCallId,
    message.toolUseId,
    message.tool_call_id,
    message.tool_use_id,
    message.callId,
    message.call_id,
  ]
    .map(normalizeOptionalString)
    .find(Boolean);
}

function findMessageToolCallIndexInSourceTurn(params: {
  messages: readonly unknown[];
  sourceTurnRange: { startIndex: number; endIndex: number };
  toolCallId: string;
}): number | undefined {
  for (
    let index = params.sourceTurnRange.endIndex - 1;
    index > params.sourceTurnRange.startIndex;
    index -= 1
  ) {
    const message = params.messages[index];
    if (!message || typeof message !== "object" || getMessageRole(message) !== "assistant") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    const matched = content.some((block) => {
      if (!block || typeof block !== "object") {
        return false;
      }
      const record = block as Record<string, unknown>;
      const type = normalizeOptionalString(record.type);
      return (
        (type === "toolCall" || type === "toolUse" || type === "tool_use") &&
        normalizeOptionalString(record.id) === params.toolCallId &&
        normalizeOptionalString(record.name) === "message"
      );
    });
    if (matched) {
      return index;
    }
  }
  return undefined;
}

function hasSiblingAssistantToolCalls(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "assistant") {
    return true;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return true;
  }
  let toolCallCount = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = normalizeOptionalString((block as { type?: unknown }).type);
    if (type === "toolCall" || type === "toolUse" || type === "tool_use") {
      toolCallCount += 1;
    }
  }
  return toolCallCount !== 1;
}

function isSuccessfulMessageToolResult(message: unknown, toolCallId: string): boolean {
  const role = getMessageRole(message);
  if (!message || typeof message !== "object" || (role !== "tool" && role !== "toolResult")) {
    return false;
  }
  const record = message as Record<string, unknown>;
  return (
    readToolCallId(record) === toolCallId &&
    normalizeOptionalString(record.toolName) === "message" &&
    record.isError !== true
  );
}

function findSuccessfulMessageToolResultIndex(params: {
  messages: readonly unknown[];
  sourceTurnRange: { startIndex: number; endIndex: number };
  toolCallId: string;
  toolCallIndex: number;
}): number | undefined {
  for (let index = params.toolCallIndex + 1; index < params.sourceTurnRange.endIndex; index += 1) {
    if (isSuccessfulMessageToolResult(params.messages[index], params.toolCallId)) {
      return index;
    }
  }
  return undefined;
}

function isSafeTerminalDeliveryTailMessage(params: {
  message: unknown;
  sourceTurnId: string;
  toolCallId: string;
}): boolean {
  const mirror = readTerminalSourceReplyDeliveryMirror(params.message);
  if (mirror?.sourceTurnId === params.sourceTurnId && mirror.toolCallId === params.toolCallId) {
    return true;
  }
  // An empty provider abort is restart lifecycle noise. Partial output remains unsafe.
  return isRestartAbortTailArtifact(params.message);
}

function canReconcileTerminalDeliveryAtSourceTurnTail(params: {
  messages: readonly unknown[];
  sourceTurnId: string;
  sourceTurnRange: { startIndex: number; endIndex: number };
  toolCallId: string;
  toolCallIndex: number;
  successfulToolResultIndex?: number;
}): boolean {
  if (params.sourceTurnRange.endIndex !== params.messages.length) {
    return false;
  }
  for (
    let messageIndex = params.toolCallIndex + 1;
    messageIndex < params.sourceTurnRange.endIndex;
    messageIndex += 1
  ) {
    if (messageIndex === params.successfulToolResultIndex) {
      continue;
    }
    const message = params.messages[messageIndex];
    if (
      params.successfulToolResultIndex !== undefined &&
      messageIndex > params.successfulToolResultIndex &&
      messageIndex === params.sourceTurnRange.endIndex - 1 &&
      isTerminalSilentAssistantMessage(message)
    ) {
      continue;
    }
    if (
      isSafeTerminalDeliveryTailMessage({
        message,
        sourceTurnId: params.sourceTurnId,
        toolCallId: params.toolCallId,
      })
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function buildRecoveryToolResultIdempotencyKey(sourceTurnId: string, toolCallId: string): string {
  return `restart-recovery:message-tool-result:${sourceTurnId}:${toolCallId}`;
}

type RecoveryCheckpointCompletion =
  | { outcome: "completed" }
  | { outcome: "changed" }
  | { outcome: "unsafe-transcript"; reason: string };

export async function markSessionCompletedAfterRecoveryCheckpoint(params: {
  agentId: string;
  entry: SessionEntry;
  messages: readonly unknown[];
  pendingFinalDeliveryIntentId?: string;
  reason: "delivered-terminal" | "delivered-terminal-receipt" | "handled-silent";
  storePath: string;
  sessionKey: string;
  sourceTurnId?: string;
  toolCallId?: string;
}): Promise<RecoveryCheckpointCompletion> {
  const expectedRecoveryRunId = normalizeOptionalString(params.entry.restartRecoveryDeliveryRunId);
  const expectedRecoverySourceRunId = normalizeOptionalString(
    params.entry.restartRecoveryDeliverySourceRunId,
  );
  const endedAt = Date.now();
  const lifecyclePatch: SessionTranscriptTurnLifecyclePatch = {
    ...buildRestartRecoveryClaimCleanupPatch({
      entry: params.entry,
      recordTerminalSource: expectedRecoverySourceRunId !== undefined,
      terminalSourceRunId: expectedRecoverySourceRunId,
    }),
    abortedLastRun: false,
    lifecycleRunId: undefined,
    lastRunId: resolveRestartRecoveryTerminalClientRunId(params.entry),
    endedAt,
    pendingFinalDelivery: undefined,
    restartRecoveryForceSafeTools: undefined,
    restartRecoveryRuns: undefined,
    ...buildMainSessionRecoveryClearPatch(params.entry),
    runtimeMs:
      typeof params.entry.startedAt === "number"
        ? Math.max(0, endedAt - params.entry.startedAt)
        : undefined,
    status: "done",
    updatedAt: endedAt,
  };
  const sourceTurnId = normalizeOptionalString(params.sourceTurnId);
  if (params.reason === "handled-silent" && !sourceTurnId) {
    return {
      outcome: "unsafe-transcript",
      reason: "handled silent checkpoint lacks its durable source turn",
    };
  }
  const sourceTurnRange = sourceTurnId
    ? findSourceTurnRange({
        continuationRunId: expectedRecoveryRunId,
        messages: params.messages,
        sourceTurnId,
      })
    : undefined;
  const toolCallId = normalizeOptionalString(params.toolCallId);
  if (sourceTurnId && sourceTurnRange === undefined) {
    return {
      outcome: "unsafe-transcript",
      reason: "recovery checkpoint cannot be matched to its durable source turn",
    };
  }
  if (sourceTurnRange && sourceTurnRange.endIndex !== params.messages.length) {
    return {
      outcome: "unsafe-transcript",
      reason: "recovery checkpoint belongs to an earlier transcript turn",
    };
  }
  if (toolCallId && !sourceTurnId) {
    return {
      outcome: "unsafe-transcript",
      reason: "terminal delivery lacks its durable source turn",
    };
  }
  const messageToolCallIndex =
    toolCallId && sourceTurnRange
      ? findMessageToolCallIndexInSourceTurn({
          messages: params.messages,
          sourceTurnRange,
          toolCallId,
        })
      : undefined;
  if (toolCallId && messageToolCallIndex === undefined) {
    return {
      outcome: "unsafe-transcript",
      reason: "terminal delivery cannot be matched to its message tool call",
    };
  }
  if (
    messageToolCallIndex !== undefined &&
    hasSiblingAssistantToolCalls(params.messages[messageToolCallIndex])
  ) {
    return {
      outcome: "unsafe-transcript",
      reason: "terminal message tool call has sibling tool work",
    };
  }
  const recoveryToolResultIdempotencyKey =
    toolCallId && sourceTurnId
      ? buildRecoveryToolResultIdempotencyKey(sourceTurnId, toolCallId)
      : undefined;
  const successfulToolResultIndex =
    toolCallId && sourceTurnRange && messageToolCallIndex !== undefined
      ? findSuccessfulMessageToolResultIndex({
          messages: params.messages,
          sourceTurnRange,
          toolCallId,
          toolCallIndex: messageToolCallIndex,
        })
      : undefined;
  if (
    toolCallId &&
    sourceTurnId &&
    sourceTurnRange !== undefined &&
    messageToolCallIndex !== undefined &&
    !canReconcileTerminalDeliveryAtSourceTurnTail({
      messages: params.messages,
      sourceTurnId,
      sourceTurnRange,
      toolCallId,
      toolCallIndex: messageToolCallIndex,
      successfulToolResultIndex,
    })
  ) {
    return {
      outcome: "unsafe-transcript",
      reason:
        successfulToolResultIndex === undefined
          ? "terminal delivery would require an out-of-order transcript repair"
          : "terminal delivery result is followed by unfinished transcript work",
    };
  }
  if (
    toolCallId &&
    sourceTurnId &&
    sourceTurnRange !== undefined &&
    messageToolCallIndex !== undefined &&
    recoveryToolResultIdempotencyKey &&
    successfulToolResultIndex === undefined
  ) {
    const expectedSessionState = buildRestartRecoveryExpectedState(params.entry);
    const persisted = await persistSessionTranscriptTurn(
      {
        agentId: params.agentId,
        sessionId: params.entry.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      {
        expectedSessionId: params.entry.sessionId,
        expectedSessionState,
        messages: [
          {
            idempotencyLookup: "scan",
            message: {
              role: "toolResult",
              toolCallId,
              toolName: "message",
              content: [{ type: "text", text: "Message delivered before gateway restart." }],
              idempotencyKey: recoveryToolResultIdempotencyKey,
              isError: false,
              timestamp: endedAt,
            },
          },
        ],
        sessionLifecyclePatch: lifecyclePatch,
        updateMode: "none",
      },
    );
    const completed = persisted.sessionEntry?.status === "done";
    if (completed) {
      mainSessionRecoveryLog.info(
        `reconciled delivered terminal reply after restart: ${params.sessionKey}`,
      );
    }
    return { outcome: completed ? "completed" : "changed" };
  }
  const marked = await applySessionEntryReplacements({
    agentId: params.agentId,
    sessionKeys: [params.sessionKey],
    storePath: params.storePath,
    update: (entries) => {
      const current = entries.find((candidate) => candidate.sessionKey === params.sessionKey);
      const entry = current?.entry;
      if (
        !entry ||
        entry.sessionId !== params.entry.sessionId ||
        (params.pendingFinalDeliveryIntentId !== undefined &&
          entry.pendingFinalDelivery?.intentId !== params.pendingFinalDeliveryIntentId) ||
        entry.status !== "running" ||
        entry.abortedLastRun !== true ||
        normalizeOptionalString(entry.restartRecoveryDeliveryRunId) !== expectedRecoveryRunId ||
        normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) !==
          expectedRecoverySourceRunId
      ) {
        return { result: false };
      }
      Object.assign(entry, lifecyclePatch);
      return {
        result: true,
        replacements: [{ sessionKey: params.sessionKey, entry }],
      };
    },
  });
  if (marked) {
    mainSessionRecoveryLog.info(
      params.reason === "delivered-terminal" || params.reason === "delivered-terminal-receipt"
        ? `reconciled delivered terminal reply after restart: ${params.sessionKey}`
        : `reconciled handled silent reply after restart: ${params.sessionKey}`,
    );
  }
  return { outcome: marked ? "completed" : "changed" };
}
