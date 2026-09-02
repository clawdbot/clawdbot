import { asNullableObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeNullableString as toTrimmedString,
  normalizeLowercaseStringOrEmpty,
} from "@openclaw/normalization-core/string-coerce";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";
import type {
  AgentEventPayload,
  CompactionStatus,
  ToolStreamHost,
} from "./tool-stream-contract.ts";

type SessionOperationEventPayload = {
  operationId?: string;
  operation?: string;
  phase?: string;
  sessionKey?: string;
  agentId?: string;
  ts?: number;
  completed?: boolean;
  reason?: string;
};

function resolveModelLabel(provider: unknown, model: unknown): string | null {
  const modelValue = toTrimmedString(model);
  if (!modelValue) {
    return null;
  }
  const providerValue = toTrimmedString(provider);
  if (providerValue) {
    const prefix = `${providerValue}/`;
    const trimmedModel = normalizeLowercaseStringOrEmpty(modelValue).startsWith(
      normalizeLowercaseStringOrEmpty(prefix),
    )
      ? modelValue.slice(prefix.length).trim()
      : modelValue;
    return `${providerValue}/${trimmedModel || modelValue}`;
  }
  const slashIndex = modelValue.indexOf("/");
  if (slashIndex > 0) {
    const p = modelValue.slice(0, slashIndex).trim();
    const m = modelValue.slice(slashIndex + 1).trim();
    if (p && m) {
      return `${p}/${m}`;
    }
  }
  return modelValue;
}

function parseFallbackAttemptSummaries(summaries: unknown, attempts: unknown): string[] {
  if (Array.isArray(summaries)) {
    const formatted = summaries
      .map((entry) => toTrimmedString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => formatUiError(entry));
    if (formatted.length > 0) {
      return formatted;
    }
  }
  if (!Array.isArray(attempts)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of attempts) {
    const item = readRecord(entry);
    const provider = toTrimmedString(item?.provider);
    const model = toTrimmedString(item?.model);
    if (!provider || !model) {
      continue;
    }
    const reason = formatUiError(
      toTrimmedString(item?.reason)?.replace(/_/g, " ") ??
        toTrimmedString(item?.code) ??
        (typeof item?.status === "number" ? `HTTP ${item.status}` : null) ??
        toTrimmedString(item?.error) ??
        "error",
    );
    const modelRef = resolveModelLabel(provider, model) ?? `${provider}/${model}`;
    out.push(`${modelRef}: ${formatUiExternalText(reason)}`);
  }
  return out;
}

export function resolveChatProjectionRunId(params: {
  localRunId?: string | null;
  activeRunIds?: readonly string[];
  queue?: readonly ChatQueueItem[];
}): string | null {
  if (params.localRunId) {
    return params.localRunId;
  }
  const activeRunIds = new Set(params.activeRunIds ?? []);
  // A session row can lag local completion. Restore its run identity only when
  // the durable outbox independently proves that the same send is reconnecting.
  return (
    params.queue?.find(
      (item) =>
        item.sendState === "waiting-reconnect" &&
        typeof item.sendRunId === "string" &&
        activeRunIds.has(item.sendRunId),
    )?.sendRunId ?? null
  );
}

type WaitingApprovalSnapshotHost = Pick<
  ToolStreamHost,
  | "sessionKey"
  | "assistantAgentId"
  | "agentsList"
  | "hello"
  | "knownAgentRunIds"
  | "waitingApprovalStatuses"
  | "waitingApprovalResolvedIds"
>;

export function reconcileWaitingApprovalsFromSnapshot(
  host: WaitingApprovalSnapshotHost,
  queue: readonly ExecApprovalRequest[],
): boolean {
  const waiting = (host.waitingApprovalStatuses ??= new Map());
  const resolvedIds = (host.waitingApprovalResolvedIds ??= new Set());
  const allQueuedIds = new Set(queue.map((approval) => approval.id));
  for (const approvalId of resolvedIds) {
    if (!allQueuedIds.has(approvalId)) {
      resolvedIds.delete(approvalId);
    }
  }
  const matchingApprovals = queue.filter(
    (approval) =>
      approval.kind === "exec" &&
      approval.request.sessionKey &&
      uiSessionEventMatches(host, approval.request.sessionKey, approval.request.agentId),
  );
  const queuedIds = new Set(matchingApprovals.map((approval) => approval.id));
  let changed = false;
  for (const approvalId of waiting.keys()) {
    if (!queuedIds.has(approvalId)) {
      waiting.delete(approvalId);
      changed = true;
    }
  }
  if (waiting.size > 0) {
    return changed;
  }
  // On a fresh mount the inline approval card still exposes the parked request in the transcript.
  // Spinner-label hydration across mounts needs an authoritative Gateway run-state contract and
  // is deliberately deferred.
  for (const approval of matchingApprovals) {
    const runId = toTrimmedString(approval.request.runId);
    if (!runId || !host.knownAgentRunIds?.has(runId) || resolvedIds.has(approval.id)) {
      continue;
    }
    waiting.set(approval.id, {
      approvalId: approval.id,
      toolCallId: null,
      runId,
    });
    changed = true;
  }
  return changed;
}

const COMPACTION_ACTIVE_STALE_TIMEOUT_MS = 5 * 60_000;
const FALLBACK_TOAST_DURATION_MS = 8000;

function clearCompactionTimer(host: ToolStreamHost) {
  if (host.compactionClearTimer != null) {
    window.clearTimeout(host.compactionClearTimer);
    host.compactionClearTimer = null;
  }
}

function scheduleCompactionClear(
  host: ToolStreamHost,
  delayMs: number,
  expected?: { phase?: CompactionStatus["phase"]; runId?: string | null },
) {
  host.compactionClearTimer = window.setTimeout(() => {
    const current = host.compactionStatus;
    if (expected?.phase && current?.phase !== expected.phase) {
      return;
    }
    if (expected?.runId && current?.runId !== expected.runId) {
      return;
    }
    host.compactionStatus = null;
    host.compactionClearTimer = null;
    host.requestUpdate?.();
  }, delayMs);
}

function setCompactionStatus(
  host: ToolStreamHost,
  runId: string,
  phase: CompactionStatus["phase"],
  itemId?: string,
) {
  const completed = phase === "complete";
  const previous = host.compactionStatus;
  const sameOperation =
    previous?.runId === runId && (!itemId || !previous.itemId || previous.itemId === itemId);
  const currentItemId = itemId ?? (sameOperation ? previous?.itemId : undefined);
  clearCompactionTimer(host);
  host.compactionStatus = {
    phase,
    runId,
    ...(currentItemId ? { itemId: currentItemId } : {}),
    startedAt: sameOperation ? previous.startedAt : Date.now(),
    completedAt: completed ? Date.now() : null,
  };
  if (!completed) {
    scheduleCompactionClear(host, COMPACTION_ACTIVE_STALE_TIMEOUT_MS, { phase, runId });
  }
}

export function handleSessionOperationEvent(
  host: ToolStreamHost,
  payload?: SessionOperationEventPayload,
) {
  if (!payload || payload.operation !== "compact") {
    return;
  }
  const sessionKey = toTrimmedString(payload.sessionKey);
  const agentId = toTrimmedString(payload.agentId) ?? undefined;
  if (!sessionKey || !uiSessionEventMatches(host, sessionKey, agentId)) {
    return;
  }

  const operationId = toTrimmedString(payload.operationId) ?? `session-compact:${sessionKey}`;

  if (payload.phase === "start") {
    clearCompactionTimer(host);
    setCompactionStatus(host, operationId, "active");
    return;
  }

  if (payload.phase !== "end") {
    return;
  }
  if (host.compactionStatus?.runId && host.compactionStatus.runId !== operationId) {
    return;
  }
  clearCompactionTimer(host);
  if (payload.completed === true) {
    setCompactionStatus(host, operationId, "complete");
    return;
  }
  host.compactionStatus = null;
}

function handleCompactionEvent(host: ToolStreamHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = typeof data.phase === "string" ? data.phase : "";
  const completed = data.completed === true;
  const itemId = toTrimmedString(data.itemId) ?? undefined;

  clearCompactionTimer(host);

  if (phase === "start") {
    setCompactionStatus(host, payload.runId, "active", itemId);
    return;
  }
  if (phase === "end") {
    if (data.willRetry === true && completed) {
      // Compaction already succeeded, but the run is still retrying.
      // Keep that distinct state until the matching lifecycle end arrives.
      setCompactionStatus(host, payload.runId, "retrying", itemId);
      return;
    }
    if (completed) {
      setCompactionStatus(host, payload.runId, "complete", itemId);
      return;
    }
    host.compactionStatus = null;
  }
}

function handleLifecycleCompactionEvent(host: ToolStreamHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = toTrimmedString(data.phase);
  if (phase !== "end" && phase !== "error") {
    return;
  }

  // We scope lifecycle cleanup to the visible chat session first, then
  // use runId only to match the specific compaction retry we started tracking.
  const accepted = resolveAcceptedSession(host, payload, { allowSessionScopedWhenIdle: true });
  if (!accepted.accepted) {
    return;
  }
  if (host.compactionStatus?.phase !== "retrying") {
    return;
  }
  if (host.compactionStatus.runId && host.compactionStatus.runId !== payload.runId) {
    return;
  }

  setCompactionStatus(host, payload.runId, "complete");
}

export function resolveAcceptedSession(
  host: ToolStreamHost,
  payload: AgentEventPayload,
  options?: {
    allowSessionScopedWhenIdle?: boolean;
  },
): { accepted: boolean; sessionKey?: string } {
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (sessionKey && !uiSessionEventMatches(host, sessionKey, toTrimmedString(payload.agentId))) {
    return { accepted: false };
  }
  if (!host.chatRunId && options?.allowSessionScopedWhenIdle && sessionKey) {
    return { accepted: true, sessionKey };
  }
  if (host.chatRunId && payload.runId !== host.chatRunId) {
    return { accepted: false };
  }
  if (!host.chatRunId) {
    return { accepted: false };
  }
  return { accepted: true, sessionKey };
}

function handleLifecycleFallbackEvent(host: ToolStreamHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = payload.stream === "fallback" ? "fallback" : toTrimmedString(data.phase);
  if (payload.stream === "lifecycle" && phase !== "fallback" && phase !== "fallback_cleared") {
    return;
  }

  const accepted = resolveAcceptedSession(host, payload, { allowSessionScopedWhenIdle: true });
  if (!accepted.accepted) {
    return;
  }

  const selected =
    resolveModelLabel(data.selectedProvider, data.selectedModel) ??
    resolveModelLabel(data.fromProvider, data.fromModel);
  const active =
    resolveModelLabel(data.activeProvider, data.activeModel) ??
    resolveModelLabel(data.toProvider, data.toModel);
  const previous =
    resolveModelLabel(data.previousActiveProvider, data.previousActiveModel) ??
    toTrimmedString(data.previousActiveModel);
  if (!selected || !active) {
    return;
  }
  if (phase === "fallback" && selected === active) {
    return;
  }

  const rawReason = toTrimmedString(data.reasonSummary) ?? toTrimmedString(data.reason);
  const reason = rawReason ? formatUiError(rawReason) : null;
  const attempts = parseFallbackAttemptSummaries(data.attemptSummaries, data.attempts);

  if (host.fallbackClearTimer != null) {
    window.clearTimeout(host.fallbackClearTimer);
    host.fallbackClearTimer = null;
  }
  host.fallbackStatus = {
    phase: phase === "fallback_cleared" ? "cleared" : "active",
    selected,
    active: phase === "fallback_cleared" ? selected : active,
    previous:
      phase === "fallback_cleared"
        ? (previous ?? (active !== selected ? active : undefined))
        : undefined,
    reason: reason ?? undefined,
    attempts,
    occurredAt: Date.now(),
  };
  host.fallbackClearTimer = window.setTimeout(() => {
    host.fallbackStatus = null;
    host.fallbackClearTimer = null;
    host.requestUpdate?.();
  }, FALLBACK_TOAST_DURATION_MS);
}

function handleLifecycleApprovalEvent(host: ToolStreamHost, payload: AgentEventPayload): boolean {
  const phase = toTrimmedString(payload.data?.phase);
  if (phase !== "waiting-approval" && phase !== "approval-resolved") {
    return false;
  }
  const approvalId = toTrimmedString(payload.data?.approvalId);
  const sessionKey = toTrimmedString(payload.sessionKey);
  if (!approvalId || !sessionKey) {
    return true;
  }
  if (phase === "waiting-approval") {
    const waiting = (host.waitingApprovalStatuses ??= new Map());
    host.waitingApprovalResolvedIds?.delete(approvalId);
    waiting.set(approvalId, {
      approvalId,
      toolCallId: toTrimmedString(payload.data?.toolCallId),
      runId: payload.runId,
    });
    return true;
  }
  (host.waitingApprovalResolvedIds ??= new Set()).add(approvalId);
  host.waitingApprovalStatuses?.delete(approvalId);
  return true;
}

export function handleStreamStatus(host: ToolStreamHost, payload: AgentEventPayload): boolean {
  if (payload.stream === "compaction") {
    handleCompactionEvent(host, payload);
    return true;
  }
  if (payload.stream === "lifecycle") {
    if (handleLifecycleApprovalEvent(host, payload)) {
      return true;
    }
    handleLifecycleCompactionEvent(host, payload);
    handleLifecycleFallbackEvent(host, payload);
    return true;
  }
  if (payload.stream === "fallback") {
    handleLifecycleFallbackEvent(host, payload);
    return true;
  }
  return false;
}
