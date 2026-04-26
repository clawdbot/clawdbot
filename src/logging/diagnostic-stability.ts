import {
  onDiagnosticEvent,
  type DiagnosticEventPayload,
  type DiagnosticMemoryUsage,
} from "../infra/diagnostic-events.js";

export const DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY = 1000;
export const DEFAULT_DIAGNOSTIC_STABILITY_LIMIT = 50;
export const MAX_DIAGNOSTIC_STABILITY_LIMIT = DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY;

const SAFE_REASON_CODE = /^[A-Za-z0-9_.:-]{1,120}$/u;

export type DiagnosticStabilityEventRecord = {
  seq: number;
  ts: number;
  type: DiagnosticEventPayload["type"];
  channel?: string;
  pluginId?: string;
  source?: string;
  target?: string;
  surface?: string;
  action?: string;
  reason?: string;
  outcome?: string;
  mode?: string;
  level?: string;
  detector?: string;
  deliveryKind?: string;
  toolName?: string;
  pairedToolName?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  resultCount?: number;
  commandLength?: number;
  exitCode?: number;
  timedOut?: boolean;
  costUsd?: number;
  count?: number;
  bytes?: number;
  limitBytes?: number;
  thresholdBytes?: number;
  rssGrowthBytes?: number;
  windowMs?: number;
  ageMs?: number;
  queueDepth?: number;
  queueSize?: number;
  waitMs?: number;
  active?: number;
  waiting?: number;
  queued?: number;
  webhooks?: {
    received: number;
    processed: number;
    errors: number;
  };
  memory?: DiagnosticMemoryUsage;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
};

export type DiagnosticStabilitySnapshot = {
  generatedAt: string;
  capacity: number;
  count: number;
  dropped: number;
  firstSeq?: number;
  lastSeq?: number;
  events: DiagnosticStabilityEventRecord[];
  summary: {
    byType: Record<string, number>;
    memory?: {
      latest?: DiagnosticMemoryUsage;
      maxRssBytes?: number;
      maxHeapUsedBytes?: number;
      pressureCount: number;
    };
    payloadLarge?: {
      count: number;
      rejected: number;
      truncated: number;
      chunked: number;
      bySurface: Record<string, number>;
    };
  };
};

export type DiagnosticStabilityQuery = {
  limit?: number;
  type?: string;
  sinceSeq?: number;
};

export type DiagnosticStabilityQueryInput = {
  limit?: unknown;
  type?: unknown;
  sinceSeq?: unknown;
};

export type NormalizedDiagnosticStabilityQuery = {
  limit: number;
  type: string | undefined;
  sinceSeq: number | undefined;
};

type DiagnosticStabilityState = {
  records: Array<DiagnosticStabilityEventRecord | undefined>;
  capacity: number;
  nextIndex: number;
  count: number;
  dropped: number;
  unsubscribe: (() => void) | null;
};

function createState(capacity = DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY): DiagnosticStabilityState {
  return {
    records: Array.from<DiagnosticStabilityEventRecord | undefined>({ length: capacity }),
    capacity,
    nextIndex: 0,
    count: 0,
    dropped: 0,
    unsubscribe: null,
  };
}

function getDiagnosticStabilityState(): DiagnosticStabilityState {
  const globalStore = globalThis as typeof globalThis & {
    __openclawDiagnosticStabilityState?: DiagnosticStabilityState;
  };
  globalStore.__openclawDiagnosticStabilityState ??= createState();
  return globalStore.__openclawDiagnosticStabilityState;
}

function copyMemory(memory: DiagnosticMemoryUsage): DiagnosticMemoryUsage {
  return { ...memory };
}

function copyReasonCode(reason: string | undefined): string | undefined {
  if (!reason || !SAFE_REASON_CODE.test(reason)) {
    return undefined;
  }
  return reason;
}

function assignReasonCode(
  record: DiagnosticStabilityEventRecord,
  reason: string | undefined,
): void {
  const reasonCode = copyReasonCode(reason);
  if (reasonCode) {
    record.reason = reasonCode;
  }
}

function isRecord(
  record: DiagnosticStabilityEventRecord | undefined,
): record is DiagnosticStabilityEventRecord {
  return record !== undefined;
}

function sanitizeDiagnosticEvent(event: DiagnosticEventPayload): DiagnosticStabilityEventRecord {
  const record: DiagnosticStabilityEventRecord = {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
  };

  switch (event.type) {
    case "model.usage":
      record.channel = event.channel;
      record.provider = event.provider;
      record.model = event.model;
      record.usage = { ...event.usage };
      record.context = event.context ? { ...event.context } : undefined;
      record.costUsd = event.costUsd;
      record.durationMs = event.durationMs;
      break;
    case "webhook.received":
      record.channel = event.channel;
      break;
    case "webhook.processed":
      record.channel = event.channel;
      record.durationMs = event.durationMs;
      break;
    case "webhook.error":
      record.channel = event.channel;
      break;
    case "message.queued":
      record.channel = event.channel;
      record.source = event.source;
      record.queueDepth = event.queueDepth;
      break;
    case "message.processed":
      record.channel = event.channel;
      record.durationMs = event.durationMs;
      record.outcome = event.outcome;
      assignReasonCode(record, event.reason);
      break;
    case "message.delivery.started":
      record.channel = event.channel;
      record.deliveryKind = event.deliveryKind;
      break;
    case "message.delivery.completed":
      record.channel = event.channel;
      record.deliveryKind = event.deliveryKind;
      record.durationMs = event.durationMs;
      record.resultCount = event.resultCount;
      record.outcome = "completed";
      break;
    case "message.delivery.error":
      record.channel = event.channel;
      record.deliveryKind = event.deliveryKind;
      record.durationMs = event.durationMs;
      record.outcome = "error";
      assignReasonCode(record, event.errorCategory);
      break;
    case "session.state":
      record.outcome = event.state;
      assignReasonCode(record, event.reason);
      record.queueDepth = event.queueDepth;
      break;
    case "session.stuck":
      record.outcome = event.state;
      record.ageMs = event.ageMs;
      record.queueDepth = event.queueDepth;
      break;
    case "queue.lane.enqueue":
      record.source = event.lane;
      record.queueSize = event.queueSize;
      break;
    case "queue.lane.dequeue":
      record.source = event.lane;
      record.queueSize = event.queueSize;
      record.waitMs = event.waitMs;
      break;
    case "run.attempt":
      record.count = event.attempt;
      break;
    case "context.assembled":
      record.channel = event.channel;
      record.provider = event.provider;
      record.model = event.model;
      record.count = event.messageCount;
      record.bytes = event.promptChars;
      record.context =
        event.contextTokenBudget !== undefined ? { limit: event.contextTokenBudget } : undefined;
      record.bytes = event.promptChars;
      break;
    case "diagnostic.heartbeat":
      record.webhooks = { ...event.webhooks };
      record.active = event.active;
      record.waiting = event.waiting;
      record.queued = event.queued;
      break;
    case "tool.loop":
      record.toolName = event.toolName;
      record.level = event.level;
      record.action = event.action;
      record.detector = event.detector;
      record.count = event.count;
      record.pairedToolName = event.pairedToolName;
      break;
    case "tool.execution.started":
      record.toolName = event.toolName;
      break;
    case "tool.execution.completed":
      record.toolName = event.toolName;
      record.durationMs = event.durationMs;
      break;
    case "tool.execution.error":
      record.toolName = event.toolName;
      record.durationMs = event.durationMs;
      assignReasonCode(record, event.errorCategory);
      break;
    case "exec.process.completed":
      record.target = event.target;
      record.mode = event.mode;
      record.outcome = event.outcome;
      record.durationMs = event.durationMs;
      record.commandLength = event.commandLength;
      record.exitCode = event.exitCode;
      record.timedOut = event.timedOut;
      assignReasonCode(record, event.failureKind);
      break;
    case "run.started":
      record.provider = event.provider;
      record.model = event.model;
      record.channel = event.channel;
      break;
    case "run.completed":
      record.provider = event.provider;
      record.model = event.model;
      record.channel = event.channel;
      record.durationMs = event.durationMs;
      record.outcome = event.outcome;
      assignReasonCode(record, event.errorCategory);
      break;
    case "harness.run.started":
      record.source = event.harnessId;
      record.pluginId = event.pluginId;
      record.provider = event.provider;
      record.model = event.model;
      record.channel = event.channel;
      break;
    case "harness.run.completed":
      record.source = event.harnessId;
      record.pluginId = event.pluginId;
      record.provider = event.provider;
      record.model = event.model;
      record.channel = event.channel;
      record.durationMs = event.durationMs;
      record.outcome = event.outcome;
      record.count = event.itemLifecycle?.completedCount;
      break;
    case "harness.run.error":
      record.source = event.harnessId;
      record.pluginId = event.pluginId;
      record.provider = event.provider;
      record.model = event.model;
      record.channel = event.channel;
      record.durationMs = event.durationMs;
      record.outcome = "error";
      record.action = event.phase;
      assignReasonCode(record, event.errorCategory);
      break;
    case "model.call.started":
      record.provider = event.provider;
      record.model = event.model;
      break;
    case "model.call.completed":
      record.provider = event.provider;
      record.model = event.model;
      record.durationMs = event.durationMs;
      break;
    case "model.call.error":
      record.provider = event.provider;
      record.model = event.model;
      record.durationMs = event.durationMs;
      assignReasonCode(record, event.errorCategory);
      break;
    case "log.record":
      record.level = event.level;
      record.source = event.loggerName;
      break;
    case "diagnostic.memory.sample":
      record.memory = copyMemory(event.memory);
      break;
    case "diagnostic.memory.pressure":
      record.level = event.level;
      assignReasonCode(record, event.reason);
      record.memory = copyMemory(event.memory);
      record.thresholdBytes = event.thresholdBytes;
      record.rssGrowthBytes = event.rssGrowthBytes;
      record.windowMs = event.windowMs;
      break;
    case "payload.large":
      record.surface = event.surface;
      record.action = event.action;
      record.bytes = event.bytes;
      record.limitBytes = event.limitBytes;
      record.count = event.count;
      record.channel = event.channel;
      record.pluginId = event.pluginId;
      assignReasonCode(record, event.reason);
      break;
    case "telemetry.exporter":
      record.source = event.exporter;
      record.target = event.signal;
      record.outcome = event.status;
      assignReasonCode(record, event.reason ?? event.errorCategory);
      break;
  }

  return record;
}

function appendRecord(record: DiagnosticStabilityEventRecord): void {
  const state = getDiagnosticStabilityState();
  state.records[state.nextIndex] = record;
  state.nextIndex = (state.nextIndex + 1) % state.capacity;
  if (state.count < state.capacity) {
    state.count += 1;
    return;
  }
  state.dropped += 1;
}

function listRecords(): DiagnosticStabilityEventRecord[] {
  const state = getDiagnosticStabilityState();
  if (state.count === 0) {
    return [];
  }
  if (state.count < state.capacity) {
    return state.records.slice(0, state.count).filter(isRecord);
  }
  return [
    ...state.records.slice(state.nextIndex),
    ...state.records.slice(0, state.nextIndex),
  ].filter(isRecord);
}

function summarizeRecords(
  records: DiagnosticStabilityEventRecord[],
): DiagnosticStabilitySnapshot["summary"] {
  const byType: Record<string, number> = {};
  let latestMemory: DiagnosticMemoryUsage | undefined;
  let maxRssBytes: number | undefined;
  let maxHeapUsedBytes: number | undefined;
  let pressureCount = 0;
  const payloadLarge = {
    count: 0,
    rejected: 0,
    truncated: 0,
    chunked: 0,
    bySurface: {} as Record<string, number>,
  };

  for (const record of records) {
    byType[record.type] = (byType[record.type] ?? 0) + 1;
    if (record.memory) {
      latestMemory = record.memory;
      maxRssBytes =
        maxRssBytes === undefined
          ? record.memory.rssBytes
          : Math.max(maxRssBytes, record.memory.rssBytes);
      maxHeapUsedBytes =
        maxHeapUsedBytes === undefined
          ? record.memory.heapUsedBytes
          : Math.max(maxHeapUsedBytes, record.memory.heapUsedBytes);
    }
    if (record.type === "diagnostic.memory.pressure") {
      pressureCount += 1;
    }
    if (record.type === "payload.large") {
      payloadLarge.count += 1;
      if (record.action === "rejected") {
        payloadLarge.rejected += 1;
      } else if (record.action === "truncated") {
        payloadLarge.truncated += 1;
      } else if (record.action === "chunked") {
        payloadLarge.chunked += 1;
      }
      const surface = record.surface ?? "unknown";
      payloadLarge.bySurface[surface] = (payloadLarge.bySurface[surface] ?? 0) + 1;
    }
  }

  return {
    byType,
    ...(latestMemory || pressureCount > 0
      ? {
          memory: {
            latest: latestMemory,
            maxRssBytes,
            maxHeapUsedBytes,
            pressureCount,
          },
        }
      : {}),
    ...(payloadLarge.count > 0 ? { payloadLarge } : {}),
  };
}

function selectRecords(
  records: DiagnosticStabilityEventRecord[],
  options?: {
    limit?: number;
    type?: string;
    sinceSeq?: number;
  },
): {
  filtered: DiagnosticStabilityEventRecord[];
  events: DiagnosticStabilityEventRecord[];
} {
  const { limit, type, sinceSeq } = normalizeDiagnosticStabilityQuery(options);
  const filtered = records.filter((record) => {
    if (type && record.type !== type) {
      return false;
    }
    if (sinceSeq !== undefined && record.seq <= sinceSeq) {
      return false;
    }
    return true;
  });
  return {
    filtered,
    events: filtered.slice(Math.max(0, filtered.length - limit)),
  };
}

function parseOptionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalType(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("type must be a non-empty string");
  }
  return value.trim();
}

function normalizeLimit(limit: unknown, defaultLimit = DEFAULT_DIAGNOSTIC_STABILITY_LIMIT): number {
  const parsed = parseOptionalNonNegativeInteger(limit, "limit");
  if (parsed === undefined) {
    return defaultLimit;
  }
  if (parsed < 1 || parsed > MAX_DIAGNOSTIC_STABILITY_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_DIAGNOSTIC_STABILITY_LIMIT}`);
  }
  return parsed;
}

export function normalizeDiagnosticStabilityQuery(
  input: DiagnosticStabilityQueryInput = {},
  options?: { defaultLimit?: number },
): NormalizedDiagnosticStabilityQuery {
  return {
    limit: normalizeLimit(input.limit, options?.defaultLimit),
    type: parseOptionalType(input.type),
    sinceSeq: parseOptionalNonNegativeInteger(input.sinceSeq, "sinceSeq"),
  };
}

export function startDiagnosticStabilityRecorder(): void {
  const state = getDiagnosticStabilityState();
  if (state.unsubscribe) {
    return;
  }
  state.unsubscribe = onDiagnosticEvent((event) => {
    appendRecord(sanitizeDiagnosticEvent(event));
  });
}

export function stopDiagnosticStabilityRecorder(): void {
  const state = getDiagnosticStabilityState();
  state.unsubscribe?.();
  state.unsubscribe = null;
}

export function getDiagnosticStabilitySnapshot(options?: {
  limit?: number;
  type?: string;
  sinceSeq?: number;
}): DiagnosticStabilitySnapshot {
  const state = getDiagnosticStabilityState();
  const { filtered, events } = selectRecords(listRecords(), options);
  return {
    generatedAt: new Date().toISOString(),
    capacity: state.capacity,
    count: filtered.length,
    dropped: state.dropped,
    firstSeq: filtered[0]?.seq,
    lastSeq: filtered.at(-1)?.seq,
    events,
    summary: summarizeRecords(filtered),
  };
}

export function selectDiagnosticStabilitySnapshot(
  snapshot: DiagnosticStabilitySnapshot,
  options?: {
    limit?: number;
    type?: string;
    sinceSeq?: number;
  },
): DiagnosticStabilitySnapshot {
  const { filtered, events } = selectRecords(snapshot.events, options);
  return {
    ...snapshot,
    count: filtered.length,
    firstSeq: filtered[0]?.seq,
    lastSeq: filtered.at(-1)?.seq,
    events,
    summary: summarizeRecords(filtered),
  };
}

export function resetDiagnosticStabilityRecorderForTest(): void {
  const state = getDiagnosticStabilityState();
  state.unsubscribe?.();
  const next = createState(state.capacity);
  const globalStore = globalThis as typeof globalThis & {
    __openclawDiagnosticStabilityState?: DiagnosticStabilityState;
  };
  globalStore.__openclawDiagnosticStabilityState = next;
}
