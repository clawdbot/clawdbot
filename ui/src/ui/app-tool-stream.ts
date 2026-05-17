import { createChatModelOverride } from "./chat-model-ref.ts";
import type { ChatModelOverride } from "./chat-model-ref.types.ts";
import { formatUnknownText, truncateText } from "./format.ts";
import { buildAgentMainSessionKey, DEFAULT_AGENT_ID, DEFAULT_MAIN_KEY } from "./session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

const TOOL_STREAM_LIMIT = 50;
const TOOL_STREAM_THROTTLE_MS = 80;
const TOOL_OUTPUT_CHAR_LIMIT = 120_000;

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
};

export type SessionOperationEventPayload = {
  operationId?: string;
  operation?: string;
  phase?: string;
  sessionKey?: string;
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
  startedAt: number;
  updatedAt: number;
  message: Record<string, unknown>;
};

type ToolStreamHost = {
  sessionKey: string;
  hello?: {
    snapshot?: {
      sessionDefaults?: SessionDefaultsSnapshot;
    };
  } | null;
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatStreamSegments: Array<{ text: string; ts: number }>;
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  chatToolMessages: Record<string, unknown>[];
  toolStreamSyncTimer: number | null;
  chatModelOverrides?: Record<string, ChatModelOverride | null>;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
};

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

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
    .filter((entry): entry is string => Boolean(entry));
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
    const reason =
      toTrimmedString(item.reason)?.replace(/_/g, " ") ??
      toTrimmedString(item.code) ??
      (typeof item.status === "number" ? `HTTP ${item.status}` : null) ??
      toTrimmedString(item.error) ??
      "error";
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

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function resolveSessionStatusModelOverride(result: unknown): ChatModelOverride | null | undefined {
  const details = readRecord(readRecord(result)?.details);
  if (!details || details.changedModel !== true) {
    return undefined;
  }
  if (Object.hasOwn(details, "modelOverride")) {
    const override = toTrimmedString(details.modelOverride);
    return override ? createChatModelOverride(override) : null;
  }
  const model = toTrimmedString(details.model);
  if (!model) {
    return undefined;
  }
  const provider = toTrimmedString(details.modelProvider);
  return createChatModelOverride(provider ? `${provider}/${model}` : model);
}

function syncSessionStatusModelOverride(host: ToolStreamHost, data: Record<string, unknown>) {
  if (!host.chatModelOverrides) {
    return;
  }
  const result = data.result;
  const details = readRecord(readRecord(result)?.details);
  const targetSessionKey = toTrimmedString(details?.sessionKey) ?? host.sessionKey;
  if (targetSessionKey !== host.sessionKey) {
    return;
  }
  const override = resolveSessionStatusModelOverride(result);
  if (override === undefined) {
    return;
  }
  host.chatModelOverrides = {
    ...host.chatModelOverrides,
    [targetSessionKey]: override,
  };
}

function readSessionDefaults(host: ToolStreamHost): SessionDefaultsSnapshot | undefined {
  return host.hello?.snapshot?.sessionDefaults;
}

function resolveDefaultMainSessionKey(host: ToolStreamHost): string {
  const defaults = readSessionDefaults(host);
  const configuredMain = toTrimmedString(defaults?.mainSessionKey);
  if (configuredMain) {
    return configuredMain;
  }
  return buildAgentMainSessionKey({
    agentId: toTrimmedString(defaults?.defaultAgentId) ?? DEFAULT_AGENT_ID,
    mainKey: toTrimmedString(defaults?.mainKey) ?? DEFAULT_MAIN_KEY,
  });
}

function normalizeSessionKeyForEventComparison(
  host: ToolStreamHost,
  value?: string,
): string | null {
  const raw = toTrimmedString(value);
  if (!raw) {
    return null;
  }
  const defaults = readSessionDefaults(host);
  const mainKey = toTrimmedString(defaults?.mainKey) ?? DEFAULT_MAIN_KEY;
  const defaultAgentId = toTrimmedString(defaults?.defaultAgentId) ?? DEFAULT_AGENT_ID;
  const canonicalMain = resolveDefaultMainSessionKey(host);
  const aliases = new Set(
    [
      DEFAULT_MAIN_KEY,
      mainKey,
      canonicalMain,
      buildAgentMainSessionKey({ agentId: defaultAgentId, mainKey: DEFAULT_MAIN_KEY }),
      buildAgentMainSessionKey({ agentId: defaultAgentId, mainKey }),
    ].map((entry) => normalizeLowercaseStringOrEmpty(entry)),
  );
  const normalizedRaw = normalizeLowercaseStringOrEmpty(raw);
  return aliases.has(normalizedRaw)
    ? normalizeLowercaseStringOrEmpty(canonicalMain)
    : normalizedRaw;
}

function buildToolStreamMessage(entry: ToolStreamEntry): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  content.push({
    type: "toolcall",
    name: entry.name,
    arguments: entry.args ?? {},
  });
  if (entry.output) {
    content.push({
      type: "toolresult",
      name: entry.name,
      text: entry.output,
    });
  }
  return {
    role: "assistant",
    toolCallId: entry.toolCallId,
    runId: entry.runId,
    content,
    timestamp: entry.startedAt,
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

export function flushToolStreamSync(host: ToolStreamHost) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
  syncToolStreamMessages(host);
}

export function scheduleToolStreamSync(host: ToolStreamHost, force = false) {
  if (force) {
    flushToolStreamSync(host);
    return;
  }
  if (host.toolStreamSyncTimer != null) {
    return;
  }
  host.toolStreamSyncTimer = window.setTimeout(
    () => flushToolStreamSync(host),
    TOOL_STREAM_THROTTLE_MS,
  );
}

export function resetToolStream(host: ToolStreamHost) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
  host.toolStreamById.clear();
  host.toolStreamOrder = [];
  host.chatToolMessages = [];
  host.chatStreamSegments = [];
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

type CompactionHost = ToolStreamHost & {
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: number | null;
  requestUpdate?: () => void;
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
  if (
    !sessionKey ||
    normalizeSessionKeyForEventComparison(host, sessionKey) !==
      normalizeSessionKeyForEventComparison(host, host.sessionKey)
  ) {
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

export function handleCompactionEvent(host: CompactionHost, payload: AgentEventPayload) {
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
  if (
    sessionKey &&
    normalizeSessionKeyForEventComparison(host, sessionKey) !==
      normalizeSessionKeyForEventComparison(host, host.sessionKey)
  ) {
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

  const reason = toTrimmedString(data.reasonSummary) ?? toTrimmedString(data.reason);
  const attempts = (() => {
    const summaries = parseFallbackAttemptSummaries(data.attemptSummaries);
    if (summaries.length > 0) {
      return summaries;
    }
    return parseFallbackAttempts(data.attempts).map((attempt) => {
      const modelRef = resolveModelLabel(attempt.provider, attempt.model);
      return `${modelRef ?? `${attempt.provider}/${attempt.model}`}: ${attempt.reason}`;
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
  }, FALLBACK_TOAST_DURATION_MS);
}

export function handleAgentEvent(host: ToolStreamHost, payload?: AgentEventPayload) {
  if (!payload) {
    return;
  }

  // Handle compaction events
  if (payload.stream === "compaction") {
    handleCompactionEvent(host as CompactionHost, payload);
    return;
  }

  if (payload.stream === "lifecycle") {
    handleLifecycleCompactionEvent(host as CompactionHost, payload);
    handleLifecycleFallbackEvent(host as CompactionHost, payload);
    return;
  }

  if (payload.stream === "fallback") {
    handleLifecycleFallbackEvent(host as CompactionHost, payload);
    return;
  }

  if (payload.stream !== "tool") {
    return;
  }

  // Filter by session only. Don't check chatRunId because the client sets it
  // to a client-generated UUID (via generateUUID in sendChatMessage), while
  // tool events arrive with the server's engine runId — they can never match.
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (sessionKey && sessionKey !== host.sessionKey) {
    return;
  }

  const data = payload.data ?? {};
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
  if (!toolCallId) {
    return;
  }
  const name = typeof data.name === "string" ? data.name : "tool";
  const phase = typeof data.phase === "string" ? data.phase : "";
  const args = phase === "start" ? data.args : undefined;
  const output =
    phase === "update"
      ? formatToolOutput(data.partialResult)
      : phase === "result"
        ? formatToolOutput(data.result)
        : undefined;
  if (name === "session_status" && phase === "result") {
    syncSessionStatusModelOverride(host, data);
  }

  const now = Date.now();
  let entry = host.toolStreamById.get(toolCallId);
  if (!entry) {
    // Commit any in-progress streaming text as a segment so it renders
    // above the tool card instead of below it.
    if (
      host.chatRunId &&
      payload.runId === host.chatRunId &&
      host.chatStream &&
      host.chatStream.trim().length > 0
    ) {
      host.chatStreamSegments = [...host.chatStreamSegments, { text: host.chatStream, ts: now }];
      host.chatStream = null;
      host.chatStreamStartedAt = null;
    }
    entry = {
      toolCallId,
      runId: payload.runId,
      sessionKey,
      name,
      args,
      output: output || undefined,
      startedAt: typeof payload.ts === "number" ? payload.ts : now,
      updatedAt: now,
      message: {},
    };
    host.toolStreamById.set(toolCallId, entry);
    host.toolStreamOrder.push(toolCallId);
  } else {
    entry.name = name;
    if (args !== undefined) {
      entry.args = args;
    }
    if (output !== undefined) {
      entry.output = output || undefined;
    }
    entry.updatedAt = now;
  }

  entry.message = buildToolStreamMessage(entry);
  trimToolStream(host);
  scheduleToolStreamSync(host, phase === "result");
}
