// Control UI module implements app tool stream behavior.
import { asNullableObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeNullableString as toTrimmedString,
  normalizeLowercaseStringOrEmpty,
} from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import type {
  ChatGuardianNotice,
  ChatQueueItem,
  ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import type { DiffStat } from "../../lib/chat/tool-call-diff.ts";
import { resolveToolCallKind } from "../../lib/chat/tool-call-view.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { formatUnknownText, truncateText } from "../../lib/format.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";
import type { ChatRunStartupState } from "./chat-run-startup.ts";
import { rolloverChatStream } from "./stream-causal-boundary.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";

const TOOL_STREAM_LIMIT = 50;
const TOOL_STREAM_THROTTLE_MS = 80;
const TOOL_OUTPUT_CHAR_LIMIT = 120_000;

type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  sessionKey?: string;
  agentId?: string;
  data: Record<string, unknown>;
};

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

export type ToolStreamEntry = {
  toolCallId: string;
  runId: string;
  sessionKey?: string;
  name: string;
  args?: unknown;
  output?: string;
  /** Structured result details (e.g. edit diff) captured from the result event. */
  details?: unknown;
  /** Monotonic edit counts received while the tool arguments stream. */
  liveDiffStat?: DiffStat;
  isError?: boolean;
  exitCode?: number;
  /** True once a result event landed, even when the output text is empty. */
  resultReceived?: boolean;
  /** The owning run ended before this call received a result. */
  interrupted?: boolean;
  startedAt: number;
  receivedAt: number;
  message: Record<string, unknown>;
};

export type ToolStreamHost = {
  sessionKey: string;
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null } | null;
  hello?: { snapshot?: unknown } | null;
  chatRunId: string | null;
  chatRunUsageById?: Map<string, number>;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunStartup?: ChatRunStartupState | null;
  chatStreamSegments: ChatStreamSegment[];
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  activityEventSeqById?: Map<string, number>;
  chatToolMessages: Record<string, unknown>[];
  guardianNotices?: ChatGuardianNotice[];
  toolStreamSyncTimer: number | null;
  knownAgentRunIds?: Set<string>;
  waitingApprovalStatuses?: Map<string, WaitingApprovalStatus>;
  waitingApprovalResolvedIds?: Set<string>;
  requestUpdate?: () => void;
  sessions: Pick<SessionCapability, "setModelOverride">;
};

function resolveModelLabel(provider: unknown, model: unknown): string | null {
  const modelValue = toTrimmedString(model);
  if (!modelValue) {
    return null;
  }
  const providerValue = toTrimmedString(provider);
  if (providerValue) {
    const prefix = `${providerValue}/`;
    if (
      normalizeLowercaseStringOrEmpty(modelValue).startsWith(
        normalizeLowercaseStringOrEmpty(prefix),
      )
    ) {
      const trimmedModel = modelValue.slice(prefix.length).trim();
      if (trimmedModel) {
        return `${providerValue}/${trimmedModel}`;
      }
    }
    return `${providerValue}/${modelValue}`;
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

type FallbackAttempt = {
  provider: string;
  model: string;
  reason: string;
};

function parseFallbackAttemptSummaries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => toTrimmedString(entry))
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => formatUiError(entry));
}

function parseFallbackAttempts(value: unknown): FallbackAttempt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: FallbackAttempt[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const provider = toTrimmedString(item.provider);
    const model = toTrimmedString(item.model);
    if (!provider || !model) {
      continue;
    }
    const reason = formatUiError(
      toTrimmedString(item.reason)?.replace(/_/g, " ") ??
        toTrimmedString(item.code) ??
        (typeof item.status === "number" ? `HTTP ${item.status}` : null) ??
        toTrimmedString(item.error) ??
        "error",
    );
    out.push({ provider, model, reason });
  }
  return out;
}

function extractToolOutputText(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = record.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const entry = item as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") {
        return entry.text;
      }
      return null;
    })
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function formatToolOutput(value: unknown, keepLatest = false): string | null {
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
  if (text.length <= TOOL_OUTPUT_CHAR_LIMIT) {
    return text;
  }
  if (!keepLatest) {
    const truncated = truncateText(text, TOOL_OUTPUT_CHAR_LIMIT);
    return `${truncated.text}\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`;
  }
  return `[output truncated; showing latest ${TOOL_OUTPUT_CHAR_LIMIT} chars]\n${sliceUtf16Safe(
    text,
    -TOOL_OUTPUT_CHAR_LIMIT,
  )}`;
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

function resolveSessionStatusModelOverride(result: unknown): string | null | undefined {
  const details = readRecord(readRecord(result)?.details);
  if (!details || details.changedModel !== true) {
    return undefined;
  }
  if (Object.hasOwn(details, "modelOverride")) {
    const override = toTrimmedString(details.modelOverride);
    return override;
  }
  const model = toTrimmedString(details.model);
  if (!model) {
    return undefined;
  }
  const provider = toTrimmedString(details.modelProvider);
  return provider ? `${provider}/${model}` : model;
}

function syncSessionStatusModelOverride(host: ToolStreamHost, data: Record<string, unknown>) {
  const result = data.result;
  const details = readRecord(readRecord(result)?.details);
  const targetSessionKey = toTrimmedString(details?.sessionKey) ?? host.sessionKey;
  if (!uiSessionEventMatches(host, targetSessionKey, toTrimmedString(details?.agentId))) {
    return;
  }
  const override = resolveSessionStatusModelOverride(result);
  if (override === undefined) {
    return;
  }
  host.sessions.setModelOverride(targetSessionKey, override);
}

function buildToolStreamMessage(entry: ToolStreamEntry): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  content.push({
    type: "toolcall",
    name: entry.name,
    arguments: entry.args ?? {},
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
    __openclawToolStreamInterrupted: entry.interrupted === true,
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

function flushToolStreamSync(host: ToolStreamHost) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
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
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
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

export function interruptOpenToolStream(host: ToolStreamHost, runId: string | null): boolean {
  if (!runId) {
    return false;
  }
  let changed = false;
  for (const entry of host.toolStreamById.values()) {
    if (entry.runId !== runId || entry.resultReceived) {
      continue;
    }
    entry.interrupted = true;
    entry.liveDiffStat = undefined;
    entry.message = buildToolStreamMessage(entry);
    changed = true;
  }
  if (changed) {
    flushToolStreamSync(host);
  }
  return changed;
}

function activityEventIdentity(payload: AgentEventPayload): string | null {
  if (payload.stream === "tool") {
    const toolCallId = toTrimmedString(payload.data?.toolCallId);
    return toolCallId ? `tool:${payload.runId}:${toolCallId}` : null;
  }
  if (payload.stream === "item" && payload.data?.kind === "preamble") {
    const itemId =
      toTrimmedString(payload.data?.itemId) ?? toTrimmedString(payload.data?.id) ?? "latest";
    return `preamble:${payload.runId}:${itemId}`;
  }
  return null;
}

function acceptActivityEvent(host: ToolStreamHost, payload: AgentEventPayload): boolean {
  const identity = activityEventIdentity(payload);
  if (!identity) {
    return true;
  }
  const seq = Number.isSafeInteger(payload.seq) ? payload.seq : 0;
  const previous = host.activityEventSeqById?.get(identity);
  if (previous !== undefined && seq <= previous) {
    return false;
  }
  const sequences = (host.activityEventSeqById ??= new Map());
  sequences.set(identity, seq);
  return true;
}

export type CompactionStatus = {
  phase: "active" | "retrying" | "complete";
  runId: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

export type FallbackStatus = {
  phase?: "active" | "cleared";
  selected: string;
  active: string;
  previous?: string;
  reason?: string;
  attempts: string[];
  occurredAt: number;
};

export type WaitingApprovalStatus = {
  approvalId: string;
  toolCallId: string | null;
  runId: string;
};

export function resolveActiveRunOutputTokens(params: {
  localRunId?: string | null;
  activeRunIds?: readonly string[];
  usageByRun?: ReadonlyMap<string, number>;
}): number | null {
  const localUsage = params.localRunId ? params.usageByRun?.get(params.localRunId) : undefined;
  if (localUsage !== undefined) {
    return localUsage;
  }
  for (const runId of params.activeRunIds ?? []) {
    const usage = params.usageByRun?.get(runId);
    if (usage !== undefined) {
      return usage;
    }
  }
  return null;
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

type CompactionHost = ToolStreamHost & {
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: number | null;
};

const COMPACTION_TOAST_DURATION_MS = 5000;
const COMPACTION_ACTIVE_STALE_TIMEOUT_MS = 5 * 60_000;
const FALLBACK_TOAST_DURATION_MS = 8000;

function clearCompactionTimer(host: CompactionHost) {
  if (host.compactionClearTimer != null) {
    window.clearTimeout(host.compactionClearTimer);
    host.compactionClearTimer = null;
  }
}

function scheduleCompactionClear(
  host: CompactionHost,
  delayMs = COMPACTION_TOAST_DURATION_MS,
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

function setCompactionComplete(host: CompactionHost, runId: string) {
  host.compactionStatus = {
    phase: "complete",
    runId,
    startedAt: host.compactionStatus?.startedAt ?? null,
    completedAt: Date.now(),
  };
  scheduleCompactionClear(host, COMPACTION_TOAST_DURATION_MS, { phase: "complete", runId });
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
  const compactionHost = host as CompactionHost;

  if (payload.phase === "start") {
    clearCompactionTimer(compactionHost);
    compactionHost.compactionStatus = {
      phase: "active",
      runId: operationId,
      startedAt: Date.now(),
      completedAt: null,
    };
    scheduleCompactionClear(compactionHost, COMPACTION_ACTIVE_STALE_TIMEOUT_MS, {
      phase: "active",
      runId: operationId,
    });
    return;
  }

  if (payload.phase !== "end") {
    return;
  }
  if (
    compactionHost.compactionStatus?.runId &&
    compactionHost.compactionStatus.runId !== operationId
  ) {
    return;
  }
  clearCompactionTimer(compactionHost);
  if (payload.completed === true) {
    setCompactionComplete(compactionHost, operationId);
    return;
  }
  compactionHost.compactionStatus = null;
}

function handleCompactionEvent(host: CompactionHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = typeof data.phase === "string" ? data.phase : "";
  const completed = data.completed === true;

  clearCompactionTimer(host);

  if (phase === "start") {
    host.compactionStatus = {
      phase: "active",
      runId: payload.runId,
      startedAt: Date.now(),
      completedAt: null,
    };
    scheduleCompactionClear(host, COMPACTION_ACTIVE_STALE_TIMEOUT_MS, {
      phase: "active",
      runId: payload.runId,
    });
    return;
  }
  if (phase === "end") {
    if (data.willRetry === true && completed) {
      // Compaction already succeeded, but the run is still retrying.
      // Keep that distinct state until the matching lifecycle end arrives.
      host.compactionStatus = {
        phase: "retrying",
        runId: payload.runId,
        startedAt: host.compactionStatus?.startedAt ?? Date.now(),
        completedAt: null,
      };
      scheduleCompactionClear(host, COMPACTION_ACTIVE_STALE_TIMEOUT_MS, {
        phase: "retrying",
        runId: payload.runId,
      });
      return;
    }
    if (completed) {
      setCompactionComplete(host, payload.runId);
      return;
    }
    host.compactionStatus = null;
  }
}

function handleLifecycleCompactionEvent(host: CompactionHost, payload: AgentEventPayload) {
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

  setCompactionComplete(host, payload.runId);
}

function resolveAcceptedSession(
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
  // Fallback: only accept session-less events for the active run.
  if (!sessionKey && host.chatRunId && payload.runId !== host.chatRunId) {
    return { accepted: false };
  }
  if (host.chatRunId && payload.runId !== host.chatRunId) {
    return { accepted: false };
  }
  if (!host.chatRunId) {
    return { accepted: false };
  }
  return { accepted: true, sessionKey };
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
  if (current !== undefined && outputTokens <= current) {
    return true;
  }
  host.chatRunUsageById = new Map(host.chatRunUsageById).set(payload.runId, outputTokens);
  return true;
}

function handleLifecycleFallbackEvent(host: CompactionHost, payload: AgentEventPayload) {
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
  const attempts = (() => {
    const summaries = parseFallbackAttemptSummaries(data.attemptSummaries);
    if (summaries.length > 0) {
      return summaries;
    }
    return parseFallbackAttempts(data.attempts).map((attempt) => {
      const modelRef = resolveModelLabel(attempt.provider, attempt.model);
      return `${modelRef ?? `${attempt.provider}/${attempt.model}`}: ${formatUiExternalText(attempt.reason)}`;
    });
  })();

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

function readPreambleProgressEvent(
  payload: AgentEventPayload,
): { text: string; itemId?: string } | null {
  if (payload.stream !== "item") {
    return null;
  }
  const data = payload.data ?? {};
  if (data.kind !== "preamble") {
    return null;
  }
  const rawItemId =
    typeof data.itemId === "string" && data.itemId.trim()
      ? data.itemId
      : typeof data.id === "string" && data.id.trim()
        ? data.id
        : null;
  const itemId = rawItemId?.trim();
  const progressText = normalizePreambleProgressText(data.progressText);
  if (!progressText && !itemId) {
    return null;
  }
  return {
    text: progressText,
    ...(itemId ? { itemId } : {}),
  };
}

function normalizePreambleProgressText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const stripped = stripInlineDirectiveTagsForDelivery(value).text.trim();
  const normalized = stripped.replace(/^[\s*_`~]+|[\s*_`~]+$/gu, "").trim();
  return /^NO_REPLY$/iu.test(normalized) ? "" : stripped;
}

function handlePreambleProgressEvent(host: ToolStreamHost, payload: AgentEventPayload): boolean {
  const progress = readPreambleProgressEvent(payload);
  if (!progress) {
    return false;
  }
  // Preambles belong to the visible run; a sibling run must never replace,
  // clear, or persist its commentary into this transcript.
  if (!resolveAcceptedSession(host, payload, { allowSessionScopedWhenIdle: true }).accepted) {
    return true;
  }
  if (progress.itemId && !progress.text.trim()) {
    host.chatStreamSegments = host.chatStreamSegments.filter(
      (segment) => segment.itemId !== progress.itemId,
    );
    return true;
  }
  const existingIndex = progress.itemId
    ? host.chatStreamSegments.findIndex((segment) => segment.itemId === progress.itemId)
    : -1;
  if (existingIndex >= 0) {
    const existing = host.chatStreamSegments[existingIndex];
    if (!existing) {
      return true;
    }
    host.chatStreamSegments = host.chatStreamSegments.map((segment, index) =>
      index === existingIndex ? { ...segment, text: progress.text, runId: payload.runId } : segment,
    );
    return true;
  }
  const last = host.chatStreamSegments[host.chatStreamSegments.length - 1];
  if (!progress.itemId && last && !last.toolCallId && last.text === progress.text) {
    return true;
  }
  host.chatStreamSegments = [
    ...host.chatStreamSegments,
    {
      text: progress.text,
      ts: payload.ts,
      runId: payload.runId,
      ...(progress.itemId ? { itemId: progress.itemId } : {}),
    },
  ];
  return true;
}

function handleGuardianEvent(host: ToolStreamHost, payload: AgentEventPayload): boolean {
  if (payload.stream !== "codex_app_server.guardian") {
    return false;
  }
  const data = payload.data ?? {};
  const phase = toTrimmedString(data.phase);
  const status = toTrimmedString(data.status);
  const kind =
    phase === "warning"
      ? "warning"
      : phase === "completed" && (status === "approved" || status === "denied")
        ? status
        : null;
  if (!kind) {
    return true;
  }
  const reviewId = toTrimmedString(data.reviewId) ?? String(payload.seq);
  const command = toTrimmedString(data.command);
  const riskLevel = toTrimmedString(data.riskLevel);
  const rationale = toTrimmedString(data.rationale);
  const message = toTrimmedString(data.message);
  const notice: ChatGuardianNotice = {
    key: `guardian:${payload.runId}:${reviewId}:${kind}`,
    runId: payload.runId,
    timestamp: typeof payload.ts === "number" ? payload.ts : Date.now(),
    kind,
    ...(command ? { command } : {}),
    ...(riskLevel ? { riskLevel } : {}),
    ...(rationale ? { rationale } : {}),
    ...(message ? { message } : {}),
  };
  const current = host.guardianNotices ?? [];
  const existingIndex = current.findIndex((candidate) => candidate.key === notice.key);
  host.guardianNotices =
    existingIndex === -1
      ? [...current.slice(-49), notice]
      : current.map((candidate, index) => (index === existingIndex ? notice : candidate));
  return true;
}

type ValidatedToolActivityEvent = {
  data: Record<string, unknown>;
  phase: "start" | "input_delta" | "update" | "result";
  toolCallId: string;
  toolStreamIdentity: string;
};

function validateToolActivityEvent(
  host: ToolStreamHost,
  payload: AgentEventPayload,
): ValidatedToolActivityEvent | null {
  const data = payload.data ?? {};
  const toolCallId = toTrimmedString(data.toolCallId);
  const phase = data.phase;
  if (!toolCallId) {
    console.warn("[control-ui] Dropped tool activity without a valid target", {
      phase: toTrimmedString(phase) ?? "unknown",
      runId: payload.runId,
    });
    return null;
  }
  if (phase !== "start" && phase !== "input_delta" && phase !== "update" && phase !== "result") {
    console.warn("[control-ui] Dropped tool activity with an invalid phase", {
      phase: toTrimmedString(phase) ?? "unknown",
      runId: payload.runId,
      toolCallId,
    });
    return null;
  }
  const toolStreamIdentity = buildToolStreamIdentity(payload.runId, toolCallId);
  if (
    !host.toolStreamById.has(toolStreamIdentity) &&
    (phase === "input_delta" || phase === "update")
  ) {
    // Progress has no standalone outcome. Without a start it would poison the
    // sequence fence and create a row that can never resolve.
    console.warn("[control-ui] Dropped orphaned tool progress", {
      phase,
      runId: payload.runId,
      toolCallId,
    });
    return null;
  }
  return { data, phase, toolCallId, toolStreamIdentity };
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
  const toolActivity =
    payload.stream === "tool" ? validateToolActivityEvent(host, payload) : undefined;
  if (payload.stream === "tool" && !toolActivity) {
    return false;
  }
  // History can replay an older active-run snapshot after newer live activity.
  // Fence each tool/preamble identity by Gateway sequence so restore fills gaps
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

  if (handleGuardianEvent(host, payload)) {
    return true;
  }

  // Handle compaction events
  if (payload.stream === "compaction") {
    handleCompactionEvent(host as CompactionHost, payload);
    return true;
  }

  if (payload.stream === "lifecycle") {
    const phase = payload.data?.phase;
    if (
      (phase === "start" || phase === "end" || phase === "error") &&
      host.chatRunUsageById?.has(payload.runId)
    ) {
      const usageByRun = new Map(host.chatRunUsageById);
      usageByRun.delete(payload.runId);
      host.chatRunUsageById = usageByRun;
    }
    if (handleLifecycleApprovalEvent(host, payload)) {
      return true;
    }
    handleLifecycleCompactionEvent(host as CompactionHost, payload);
    handleLifecycleFallbackEvent(host as CompactionHost, payload);
    return true;
  }

  if (payload.stream === "fallback") {
    handleLifecycleFallbackEvent(host as CompactionHost, payload);
    return true;
  }

  if (handlePreambleProgressEvent(host, payload)) {
    return true;
  }

  if (!toolActivity) {
    return false;
  }

  const { data, phase, toolCallId, toolStreamIdentity } = toolActivity;
  let entry = host.toolStreamById.get(toolStreamIdentity);
  // A started call owns its concrete identity even when later events omit or
  // contradict it; an unnamed placeholder can still adopt its first real name.
  const name =
    phase !== "start" && entry?.name && entry.name !== "tool"
      ? entry.name
      : (toTrimmedString(data.name) ?? entry?.name ?? "tool");
  if (phase === "start" && payload.runId === host.chatRunId) {
    host.chatRunStartup = { state: "activity", runId: payload.runId };
  }
  const args = phase === "start" ? data.args : undefined;
  const keepLatestOutput = resolveToolCallKind(name, args ?? entry?.args) === "command";
  const output =
    phase === "update"
      ? formatToolOutput(data.partialResult, keepLatestOutput)
      : phase === "result"
        ? formatToolOutput(data.result, keepLatestOutput)
        : undefined;
  const resultDetails = phase === "result" ? readRecord(data.result)?.details : undefined;
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
    syncSessionStatusModelOverride(host, data);
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
      ...(resultDetails !== undefined ? { details: resultDetails } : {}),
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
    if (resultDetails !== undefined) {
      entry.details = resultDetails;
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
      entry.interrupted = false;
      entry.resultReceived = true;
    }
  }

  entry.message = buildToolStreamMessage(entry);
  trimToolStream(host);
  scheduleToolStreamSync(host, phase === "result");
  return true;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
