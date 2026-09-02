import { asNullableObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as toTrimmedString } from "@openclaw/normalization-core/string-coerce";
import type { ChatGuardianNotice, ToolApprovalReview } from "../../lib/chat/chat-types.ts";
import {
  MAX_TOOL_APPROVAL_REVIEWS,
  normalizeToolApprovalReview,
  readToolApprovalReviewOutcome,
  readToolApprovalReviews,
  resolveToolApprovalReviewOutcome,
  withToolApprovalReviews,
} from "../../lib/chat/tool-approval-reviews.ts";
import type { DiffStat } from "../../lib/chat/tool-call-diff.ts";
import { formatUnknownText, truncateText } from "../../lib/format.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";
import { reconcileChatRunStartup } from "./chat-run-startup.ts";
import { rolloverChatStream } from "./stream-causal-boundary.ts";
import type { AgentEventPayload, ToolStreamEntry, ToolStreamHost } from "./tool-stream-contract.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";
import { handlePreambleProgress } from "./tool-stream-preamble.ts";
import { handleStreamStatus, resolveAcceptedSession } from "./tool-stream-status.ts";

const TOOL_STREAM_LIMIT = 50;
const RUN_USAGE_LIMIT = 50;
const TOOL_STREAM_THROTTLE_MS = 80;
const TOOL_OUTPUT_CHAR_LIMIT = 120_000;

function extractToolOutputText(value: unknown): string | null {
  const record = readRecord(value);
  if (!record) {
    return null;
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  if (!Array.isArray(record.content)) {
    return null;
  }
  const parts: string[] = [];
  for (const content of record.content) {
    const entry = readRecord(content);
    if (entry?.type === "text" && typeof entry.text === "string" && entry.text) {
      parts.push(entry.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function formatToolOutput(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const contentText = extractToolOutputText(value);
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (contentText) {
    text = contentText;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = formatUnknownText(value);
    }
  }
  const truncated = truncateText(text, TOOL_OUTPUT_CHAR_LIMIT);
  if (!truncated.truncated) {
    return truncated.text;
  }
  return `${truncated.text}\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`;
}

function readLiveDiffStat(value: unknown): DiffStat | undefined {
  const diff = readRecord(value);
  const added = diff?.added;
  const removed = diff?.removed;
  return typeof added === "number" &&
    Number.isInteger(added) &&
    added >= 0 &&
    typeof removed === "number" &&
    Number.isInteger(removed) &&
    removed >= 0
    ? { added, removed }
    : undefined;
}

function refreshSessionStatusModel(host: ToolStreamHost, data: Record<string, unknown>) {
  const details = readRecord(readRecord(data.result)?.details);
  if (details?.changedModel !== true) {
    return;
  }
  const targetSessionKey = toTrimmedString(details.sessionKey) ?? host.sessionKey;
  const agentId = toTrimmedString(details.agentId);
  if (!agentId || !uiSessionEventMatches(host, targetSessionKey, agentId)) {
    return;
  }
  // Results can be replayed from history; read current truth without replacing pending UI intent.
  void host.sessions.refreshReplacement(agentId);
}

function buildToolStreamMessage(entry: ToolStreamEntry): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  content.push({
    type: "toolcall",
    name: entry.name,
    arguments: entry.args ?? {},
    ...(entry.details !== undefined ? { details: entry.details } : {}),
  });
  // Emit the result block whenever a result landed, even with empty output;
  // otherwise a completed no-stdout command keeps its running state in the UI.
  if (entry.output || entry.resultReceived) {
    content.push({
      type: "toolresult",
      name: entry.name,
      text: entry.output ?? "",
      ...(entry.details !== undefined ? { details: entry.details } : {}),
      ...(entry.isError !== undefined ? { isError: entry.isError } : {}),
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
    });
  }
  return {
    role: "assistant",
    toolCallId: entry.toolCallId,
    runId: entry.runId,
    content,
    timestamp: entry.startedAt,
    // Running-state markers: only live tool-stream cards may show a spinner,
    // and completion comes from the result event — partial `update` output
    // must not end the running state. Transcript messages never carry these,
    // so historical output-less calls (aborted runs) stay inert.
    __openclawToolStreamLive: true,
    __openclawToolStreamResultReceived: entry.resultReceived === true,
    ...(entry.resultReceived !== true && entry.liveDiffStat
      ? { __openclawToolStreamDiffStat: entry.liveDiffStat }
      : {}),
    __openclawToolStreamReceivedAt: entry.receivedAt,
  };
}

function trimToolStream(host: ToolStreamHost) {
  if (host.toolStreamOrder.length <= TOOL_STREAM_LIMIT) {
    return;
  }
  const overflow = host.toolStreamOrder.length - TOOL_STREAM_LIMIT;
  const removed = host.toolStreamOrder.splice(0, overflow);
  for (const id of removed) {
    host.toolStreamById.delete(id);
  }
}

function syncToolStreamMessages(host: ToolStreamHost) {
  host.chatToolMessages = host.toolStreamOrder
    .map((id) => host.toolStreamById.get(id)?.message)
    .filter((msg): msg is Record<string, unknown> => Boolean(msg));
}

function cancelToolStreamSync(host: ToolStreamHost) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
}

function flushToolStreamSync(host: ToolStreamHost) {
  cancelToolStreamSync(host);
  syncToolStreamMessages(host);
}

function scheduleToolStreamSync(host: ToolStreamHost, force = false) {
  if (force) {
    flushToolStreamSync(host);
    return;
  }
  if (host.toolStreamSyncTimer != null) {
    return;
  }
  host.toolStreamSyncTimer = window.setTimeout(() => {
    flushToolStreamSync(host);
    // The initial event rendered before this deferred projection existed.
    host.requestUpdate?.();
  }, TOOL_STREAM_THROTTLE_MS);
}

export function resetToolStream(host: ToolStreamHost) {
  cancelToolStreamSync(host);
  host.toolStreamById.clear();
  host.toolStreamOrder = [];
  host.activityEventSeqById?.clear();
  host.chatToolMessages = [];
  host.chatStreamSegments = [];
  host.knownAgentRunIds?.clear();
  host.waitingApprovalStatuses?.clear();
  // Resolution can beat the overlay queue update. Keep tombstones across transient stream resets
  // until snapshot reconciliation observes the approval leaving the queue.
}

export function resetToolStreamRun(host: ToolStreamHost, runId: string) {
  cancelToolStreamSync(host);
  const removedIdentities = new Set<string>();
  for (const identity of host.toolStreamOrder) {
    const entry = host.toolStreamById.get(identity);
    if (entry?.runId !== runId) {
      continue;
    }
    removedIdentities.add(identity);
  }
  for (const identity of removedIdentities) {
    host.toolStreamById.delete(identity);
  }
  const activityPrefix = `tool:[${JSON.stringify(runId)},`;
  for (const sequenceIdentity of host.activityEventSeqById?.keys() ?? []) {
    if (sequenceIdentity.startsWith(activityPrefix)) {
      host.activityEventSeqById?.delete(sequenceIdentity);
    }
  }
  host.toolStreamOrder = host.toolStreamOrder.filter(
    (identity) => !removedIdentities.has(identity),
  );
  syncToolStreamMessages(host);
  host.chatStreamSegments = host.chatStreamSegments.filter((segment) => segment.runId !== runId);
  host.knownAgentRunIds?.delete(runId);
  for (const [approvalId, waitingApproval] of host.waitingApprovalStatuses ?? []) {
    if (waitingApproval.runId === runId) {
      host.waitingApprovalStatuses?.delete(approvalId);
    }
  }
}

function toolActivityIdentity(runId: string, toolCallId: string): string {
  return `tool:${JSON.stringify([runId, toolCallId])}`;
}

function toolReviewSequenceIdentity(ownerIdentity: string, reviewId: string): string {
  return `${ownerIdentity}:review:${JSON.stringify(reviewId)}`;
}

function acceptActivityEvent(host: ToolStreamHost, payload: AgentEventPayload): boolean {
  const seq = Number.isSafeInteger(payload.seq) ? payload.seq : 0;
  if (payload.stream === "tool") {
    const toolCallId = toTrimmedString(payload.data?.toolCallId);
    if (!toolCallId) {
      return true;
    }
    const ownerIdentity = toolActivityIdentity(payload.runId, toolCallId);
    const terminalIdentity = `${ownerIdentity}:result`;
    const terminalSeq = host.activityEventSeqById?.get(terminalIdentity);
    const phase = toTrimmedString(payload.data?.phase);
    if (phase !== "result" && terminalSeq !== undefined && seq <= terminalSeq) {
      return false;
    }
    const reviewId =
      phase === "review" ? toTrimmedString(readRecord(payload.data.review)?.id) : undefined;
    const reviewFloor = host.activityEventSeqById?.get(`${ownerIdentity}:review-floor`);
    if (reviewId && reviewFloor !== undefined && seq <= reviewFloor) {
      return false;
    }
    const identity = reviewId ? toolReviewSequenceIdentity(ownerIdentity, reviewId) : ownerIdentity;
    const previous = host.activityEventSeqById?.get(identity);
    if (previous !== undefined && seq <= previous) {
      return false;
    }
    const sequences = (host.activityEventSeqById ??= new Map());
    sequences.set(identity, seq);
    if (phase === "result") {
      sequences.set(terminalIdentity, seq);
      for (const key of sequences.keys()) {
        if (key.startsWith(`${ownerIdentity}:review:`)) {
          sequences.delete(key);
        }
      }
    }
    return true;
  }
  let identity: string;
  const terminalLifecycle =
    payload.stream === "lifecycle" &&
    (payload.data?.phase === "end" || payload.data?.phase === "error");
  if (payload.stream === "compaction" || terminalLifecycle) {
    // One visible compaction per run: older items and retry completions must
    // not replace a newer operation restored or received on the live stream.
    identity = `compaction:${payload.runId}`;
  } else if (payload.stream === "item" && payload.data?.kind === "preamble") {
    const itemId =
      toTrimmedString(payload.data.itemId) ?? toTrimmedString(payload.data.id) ?? "latest";
    identity = `preamble:${payload.runId}:${itemId}`;
  } else {
    return true;
  }
  const previous = host.activityEventSeqById?.get(identity);
  if (previous !== undefined && seq <= previous) {
    return false;
  }
  const sequences = (host.activityEventSeqById ??= new Map());
  sequences.set(identity, seq);
  return true;
}

function handleUsageEvent(host: ToolStreamHost, payload: AgentEventPayload): boolean {
  if (payload.stream !== "usage") {
    return false;
  }
  const sessionKey = toTrimmedString(payload.sessionKey);
  if (sessionKey) {
    if (!uiSessionEventMatches(host, sessionKey, toTrimmedString(payload.agentId))) {
      return true;
    }
  } else if (!host.chatRunId || payload.runId !== host.chatRunId) {
    return true;
  }
  const rawOutputTokens = payload.data?.outputTokens;
  if (typeof rawOutputTokens !== "number" || !Number.isFinite(rawOutputTokens)) {
    return true;
  }
  const outputTokens = Math.floor(rawOutputTokens);
  if (outputTokens < 0) {
    return true;
  }
  const current = host.chatRunUsageById?.get(payload.runId);
  if (current && payload.seq <= current.seq) {
    return true;
  }
  // Keep the sequence with its count across stream resets and terminal events:
  // recovery snapshots must not overwrite newer live usage or erase the recap.
  const usageByRun = new Map(host.chatRunUsageById);
  usageByRun.delete(payload.runId);
  usageByRun.set(payload.runId, { outputTokens, seq: payload.seq });
  for (const staleRunId of [...usageByRun.keys()].slice(0, -RUN_USAGE_LIMIT)) {
    usageByRun.delete(staleRunId);
  }
  host.chatRunUsageById = usageByRun;
  return true;
}

function handleNoticeEvent(host: ToolStreamHost, payload: AgentEventPayload): boolean {
  const systemNotice = payload.stream === "notice";
  if (!systemNotice && payload.stream !== "codex_app_server.guardian") {
    return false;
  }
  if (!resolveAcceptedSession(host, payload, { allowSessionScopedWhenIdle: true }).accepted) {
    return true;
  }
  const data = payload.data ?? {};
  const phase = toTrimmedString(data.phase);
  const status = toTrimmedString(data.status);
  const reviewId = toTrimmedString(data.reviewId);
  const threadId = toTrimmedString(data.threadId);
  const turnId = toTrimmedString(data.turnId);
  const correlationId =
    reviewId ??
    (threadId && turnId && typeof data.startedAtMs === "number" && Number.isFinite(data.startedAtMs)
      ? data.startedAtMs
      : payload.seq);
  const noticeKey =
    `${systemNotice ? "system" : "guardian"}:${payload.runId}:` +
    (phase === "warning"
      ? `warning:${payload.seq}`
      : `${threadId ?? "thread"}:${turnId ?? "turn"}:${correlationId}`);
  const current = host.guardianNotices ?? [];
  const kind =
    phase === "strict_review_required"
      ? "strict-review-required"
      : phase === "warning"
        ? "warning"
        : phase === "started" && status === "inProgress"
          ? "reviewing"
          : phase === "completed" && status === "approved"
            ? "approved"
            : phase === "completed" && ["denied", "timedOut", "aborted"].includes(status ?? "")
              ? "denied"
              : null;
  if (!kind) {
    return true;
  }
  const targetItemId = toTrimmedString(data.targetItemId);
  if ((phase === "started" || phase === "completed") && targetItemId) {
    // Targeted decisions arrive again as generic tool-review metadata. Keep
    // vendor notices only for strict-review requirements and targetless reviews.
    if (phase === "completed") {
      host.guardianNotices = current.filter((candidate) => candidate.key !== noticeKey);
    }
    return true;
  }
  const notice: ChatGuardianNotice = {
    key: noticeKey,
    runId: payload.runId,
    timestamp: payload.ts,
    kind,
  };
  if (systemNotice) {
    notice.source = "system";
  }
  for (const field of ["command", "riskLevel", "rationale", "message"] as const) {
    const value = toTrimmedString(data[field]);
    if (value) {
      notice[field] = value;
    }
  }
  const existingIndex = current.findIndex((candidate) => candidate.key === notice.key);
  host.guardianNotices =
    existingIndex === -1
      ? [...current.slice(-49), notice]
      : current.map((candidate, index) => (index === existingIndex ? notice : candidate));
  return true;
}

function applyToolReviewEvent(
  host: ToolStreamHost,
  payload: AgentEventPayload,
  entry: ToolStreamEntry,
  review: ToolApprovalReview,
) {
  const toolCallId = entry.toolCallId;
  const ownerIdentity = toolActivityIdentity(payload.runId, toolCallId);
  const sequences = (host.activityEventSeqById ??= new Map());
  const sequenceFor = (candidate: ToolApprovalReview) =>
    sequences.get(toolReviewSequenceIdentity(ownerIdentity, candidate.id)) ?? 0;
  const reviewFloorKey = `${ownerIdentity}:review-floor`;
  const currentReviews = readToolApprovalReviews(entry.details);
  const newestReviewSeq = Math.max(
    sequences.get(reviewFloorKey) ?? 0,
    ...currentReviews.map(sequenceFor),
  );
  const reviews = [
    ...currentReviews.filter((candidate) => candidate.id !== review.id),
    review,
  ].toSorted((left, right) => sequenceFor(left) - sequenceFor(right));
  const evicted = reviews.slice(0, -MAX_TOOL_APPROVAL_REVIEWS);
  const retainedReviews = reviews.slice(-MAX_TOOL_APPROVAL_REVIEWS);
  if (evicted.length > 0) {
    sequences.set(
      reviewFloorKey,
      Math.max(sequences.get(reviewFloorKey) ?? 0, ...evicted.map(sequenceFor)),
    );
    for (const candidate of evicted) {
      sequences.delete(toolReviewSequenceIdentity(ownerIdentity, candidate.id));
    }
  }
  const reportedOutcome = readToolApprovalReviewOutcome(payload.data);
  const derivedOutcome = resolveToolApprovalReviewOutcome(retainedReviews);
  const currentOutcome = readToolApprovalReviewOutcome(entry.details);
  const nextOutcome =
    currentOutcome === "denied" ? "denied" : (reportedOutcome ?? derivedOutcome ?? undefined);
  entry.details = withToolApprovalReviews(
    entry.details,
    retainedReviews,
    nextOutcome && payload.seq >= newestReviewSeq ? nextOutcome : currentOutcome,
  );
  entry.message = buildToolStreamMessage(entry);
  scheduleToolStreamSync(host, true);
}

export function handleAgentEvent(host: ToolStreamHost, payload?: AgentEventPayload): boolean {
  if (!payload) {
    return false;
  }

  // Filter the shared activity stream by session first. Chat-linked events use
  // the client run id, but spawned and session-replayed events may not own the
  // active chat run; individual run-owned projections apply their own match.
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (sessionKey && !uiSessionEventMatches(host, sessionKey, toTrimmedString(payload.agentId))) {
    return false;
  }
  // History can replay an older active-run snapshot after newer live activity.
  // Fence activity by Gateway sequence so restore fills gaps
  // without regressing a result or newer progress already rendered by this pane.
  if (!acceptActivityEvent(host, payload)) {
    return false;
  }
  if (payload.stream === "lifecycle" || payload.stream === "tool") {
    const runId = toTrimmedString(payload.runId);
    if (runId) {
      (host.knownAgentRunIds ??= new Set()).add(runId);
    }
  }

  if (handleUsageEvent(host, payload)) {
    return true;
  }

  if (handleNoticeEvent(host, payload)) {
    return true;
  }

  if (handleStreamStatus(host, payload)) {
    return true;
  }

  if (handlePreambleProgress(host, payload)) {
    return true;
  }

  if (payload.stream !== "tool") {
    return false;
  }

  const data = payload.data ?? {};
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
  if (!toolCallId) {
    return false;
  }
  const toolStreamIdentity = buildToolStreamIdentity(payload.runId, toolCallId);
  let entry = host.toolStreamById.get(toolStreamIdentity);
  const phase = typeof data.phase === "string" ? data.phase : "";
  const approvalReview = phase === "review" ? normalizeToolApprovalReview(data.review) : null;
  if (phase === "review" && !approvalReview) {
    return true;
  }
  // A started call owns its concrete identity even when later events omit or
  // contradict it; an unnamed placeholder can still adopt its first real name.
  const name =
    phase !== "start" && entry?.name && entry.name !== "tool"
      ? entry.name
      : (toTrimmedString(data.name) ?? entry?.name ?? "tool");
  if (phase === "start" && payload.runId === host.chatRunId) {
    reconcileChatRunStartup(host, { state: "activity", runId: payload.runId });
  }
  const args = phase === "start" ? data.args : undefined;
  const output =
    phase === "update"
      ? formatToolOutput(data.partialResult)
      : phase === "result"
        ? formatToolOutput(data.result)
        : undefined;
  const resultDetails = phase === "result" ? readRecord(data.result)?.details : undefined;
  const resultApprovalReviewOutcome =
    readToolApprovalReviewOutcome(data) ?? readToolApprovalReviewOutcome(resultDetails);
  const initialResultDetails = resultApprovalReviewOutcome
    ? withToolApprovalReviews(resultDetails, [], resultApprovalReviewOutcome)
    : resultDetails;
  const resultIsError =
    phase === "result" && typeof data.isError === "boolean" ? data.isError : undefined;
  const resultRecord = phase === "result" ? readRecord(data.result) : undefined;
  const resultExitCode = resultRecord?.exitCode;
  const exitCode =
    typeof resultExitCode === "number" && Number.isInteger(resultExitCode)
      ? resultExitCode
      : undefined;
  const liveDiffStat = phase === "input_delta" ? readLiveDiffStat(data.diff) : undefined;
  if (name === "session_status" && phase === "result") {
    refreshSessionStatusModel(host, data);
  }

  const now = Date.now();
  if (!entry) {
    // Commit in-progress text so it remains causally above the tool card.
    rolloverChatStream(host, { runId: payload.runId, toolCallId, timestamp: now });
    entry = {
      toolCallId,
      runId: payload.runId,
      sessionKey,
      name,
      args,
      output: output || undefined,
      ...(initialResultDetails !== undefined ? { details: initialResultDetails } : {}),
      ...(resultIsError !== undefined ? { isError: resultIsError } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(liveDiffStat ? { liveDiffStat } : {}),
      ...(phase === "result" ? { resultReceived: true } : {}),
      startedAt: typeof payload.ts === "number" ? payload.ts : now,
      receivedAt: now,
      message: {},
    };
    host.toolStreamById.set(toolStreamIdentity, entry);
    host.toolStreamOrder.push(toolStreamIdentity);
  } else {
    entry.name = name;
    if (args !== undefined) {
      entry.args = args;
    }
    if (output !== undefined) {
      entry.output = output || undefined;
    }
    if (resultDetails !== undefined || resultApprovalReviewOutcome) {
      const currentOutcome = readToolApprovalReviewOutcome(entry.details);
      const outcome =
        currentOutcome === "denied" ? "denied" : (resultApprovalReviewOutcome ?? currentOutcome);
      const reviews = readToolApprovalReviews(entry.details);
      entry.details = reviews.length
        ? withToolApprovalReviews(resultDetails, reviews, outcome)
        : initialResultDetails;
    }
    if (resultIsError !== undefined) {
      entry.isError = resultIsError;
    }
    if (exitCode !== undefined) {
      entry.exitCode = exitCode;
    }
    if (liveDiffStat) {
      entry.liveDiffStat = liveDiffStat;
    }
    if (phase === "result") {
      entry.liveDiffStat = undefined;
      entry.resultReceived = true;
    }
  }

  if (approvalReview) {
    trimToolStream(host);
    applyToolReviewEvent(host, payload, entry, approvalReview);
    return true;
  }
  entry.message = buildToolStreamMessage(entry);
  trimToolStream(host);
  scheduleToolStreamSync(host, phase === "result");
  return true;
}
