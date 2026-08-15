// Trajectory runtime records bounded session events into SQLite-backed storage.
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeDiagnosticPayload } from "../agents/payload-redaction.js";
import type {
  QueuedFileWriter,
  QueuedFileWriterDiagnostics,
} from "../agents/queued-file-writer.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  loadSessionEntry,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSecrets } from "../logging/redact.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import {
  TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES,
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
} from "./paths.js";
import { appendSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import type { TrajectoryEvent, TrajectoryToolDefinition } from "./types.js";

type TrajectoryRuntimeInit = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  maxRuntimeFileBytes?: number;
  runId?: string;
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  writer?: TrajectoryRuntimeWriter;
};

type TrajectoryRuntimeRecorder = {
  enabled: true;
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
  describeFlushState: () => string | undefined;
};

const TRAJECTORY_RUNTIME_DATA_STRING_MAX_CHARS = 32_768;
const TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS = 64;
const TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS = 64;
const TRAJECTORY_RUNTIME_DATA_MAX_DEPTH = 6;
const TRAJECTORY_RUNTIME_FINAL_PROMPT_MAX_BYTES = 4 * 1024;
// Oversized events first shed repeated conversation state while keeping the
// rest of their schema-v1 payload. The compact fallback then preserves keys
// that remain useful even when every nonessential field must be dropped.
// sanitizeTrajectoryPayload bounds prompt strings before this limiter runs.
const TRAJECTORY_RUNTIME_OVERSIZE_DROP_FIRST_DATA_KEYS = [
  "messagesSnapshot",
  "messages",
  "systemPrompt",
] as const;
const OVERSIZE_PRESERVED_DATA_KEYS = ["stopReason", "usage", "promptCache", "prompt"] as const;

type TrajectoryRuntimeWriterDiagnostics = QueuedFileWriterDiagnostics;

type TrajectoryRuntimeWriter = Omit<QueuedFileWriter, "describeQueue"> & {
  describeQueue?: () => TrajectoryRuntimeWriterDiagnostics;
  nextSourceSeq?: () => number;
};

type TrajectoryRuntimeSink = {
  describeFlushState: () => string | undefined;
  flush: () => Promise<void>;
  nextSourceSeq?: () => number;
  write: (event: TrajectoryEvent, line: string) => void;
};

function truncateOversizedTrajectoryEvent(
  event: TrajectoryEvent,
  line: string,
): string | undefined {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
    return line;
  }

  const originalData = event.data ?? {};
  const originalDataKeys = Object.keys(originalData);
  const preservedDataKeys = new Set<string>();
  const baseData = {
    truncated: true,
    originalBytes: bytes,
    limitBytes: TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
    reason: "trajectory-event-size-limit",
  };
  const reducedData = { ...originalData };
  const reducedDroppedFields: string[] = [];
  for (const key of TRAJECTORY_RUNTIME_OVERSIZE_DROP_FIRST_DATA_KEYS) {
    if (!Object.hasOwn(reducedData, key)) {
      continue;
    }
    delete reducedData[key];
    reducedDroppedFields.push(key);
    const reduced = safeJsonStringify({
      ...event,
      data: {
        ...reducedData,
        ...baseData,
        droppedFields: reducedDroppedFields,
      },
    });
    if (reduced && Buffer.byteLength(reduced, "utf8") <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
      return reduced;
    }
  }

  const buildTruncatedEventLine = (includeDroppedFields: boolean): string | undefined => {
    const data: Record<string, unknown> = { ...baseData };
    for (const key of OVERSIZE_PRESERVED_DATA_KEYS) {
      if (preservedDataKeys.has(key)) {
        data[key] = originalData[key];
      }
    }
    if (includeDroppedFields) {
      const droppedFields = originalDataKeys.filter((key) => !preservedDataKeys.has(key));
      if (droppedFields.length > 0) {
        data.droppedFields = droppedFields;
      }
    }
    const truncated = safeJsonStringify({ ...event, data });
    if (truncated && Buffer.byteLength(truncated, "utf8") <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
      return truncated;
    }
    return undefined;
  };

  let best = buildTruncatedEventLine(true) ?? buildTruncatedEventLine(false);
  if (!best) {
    return undefined;
  }

  for (const key of OVERSIZE_PRESERVED_DATA_KEYS) {
    if (!Object.hasOwn(originalData, key)) {
      continue;
    }
    preservedDataKeys.add(key);
    const next = buildTruncatedEventLine(true) ?? buildTruncatedEventLine(false);
    if (next) {
      best = next;
      continue;
    }
    preservedDataKeys.delete(key);
  }
  return best;
}

function truncatedTrajectoryValue(reason: string, details: Record<string, unknown> = {}): unknown {
  return {
    truncated: true,
    reason,
    ...details,
  };
}

function limitTrajectoryPayloadValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") {
    if (value.length > TRAJECTORY_RUNTIME_DATA_STRING_MAX_CHARS) {
      return truncatedTrajectoryValue("trajectory-field-size-limit", {
        originalChars: value.length,
        limitChars: TRAJECTORY_RUNTIME_DATA_STRING_MAX_CHARS,
      });
    }
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return truncatedTrajectoryValue("trajectory-circular-reference");
  }
  if (depth >= TRAJECTORY_RUNTIME_DATA_MAX_DEPTH) {
    return truncatedTrajectoryValue("trajectory-depth-limit", {
      limitDepth: TRAJECTORY_RUNTIME_DATA_MAX_DEPTH,
    });
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const limited = value
      .slice(0, TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS)
      .map((item) => limitTrajectoryPayloadValue(item, depth + 1, seen));
    if (value.length > TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS) {
      limited.push(
        truncatedTrajectoryValue("trajectory-array-size-limit", {
          originalLength: value.length,
          limitItems: TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS,
        }),
      );
    }
    seen.delete(value);
    return limited;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const limited: Record<string, unknown> = {};
  for (const key of keys.slice(0, TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS)) {
    limited[key] = limitTrajectoryPayloadValue(record[key], depth + 1, seen);
  }
  if (keys.length > TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS) {
    limited["_truncated"] = truncatedTrajectoryValue("trajectory-object-size-limit", {
      originalKeys: keys.length,
      limitKeys: TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS,
    });
  }
  seen.delete(value);
  return limited;
}

function sanitizeTrajectoryPayload(data: Record<string, unknown>): Record<string, unknown> {
  const finalPromptText = data.finalPromptText;
  const redactedFinalPromptText =
    typeof finalPromptText === "string" ? (redactSecrets(finalPromptText) as string) : undefined;
  const boundedData =
    typeof finalPromptText === "string" &&
    typeof redactedFinalPromptText === "string" &&
    (Buffer.byteLength(finalPromptText, "utf8") > TRAJECTORY_RUNTIME_FINAL_PROMPT_MAX_BYTES ||
      Buffer.byteLength(redactedFinalPromptText, "utf8") >
        TRAJECTORY_RUNTIME_FINAL_PROMPT_MAX_BYTES)
      ? {
          ...data,
          finalPromptText: truncateUtf8Prefix(
            redactedFinalPromptText,
            TRAJECTORY_RUNTIME_FINAL_PROMPT_MAX_BYTES,
          ),
          finalPromptTextOriginalLength: finalPromptText.length,
        }
      : typeof redactedFinalPromptText === "string"
        ? { ...data, finalPromptText: redactedFinalPromptText }
        : data;
  return redactSecrets(
    sanitizeDiagnosticPayload(limitTrajectoryPayloadValue(boundedData)),
  ) as Record<string, unknown>;
}

function describeTrajectoryWriterFlushState(writer: TrajectoryRuntimeWriter): string | undefined {
  const diagnostics = writer.describeQueue?.();
  if (!diagnostics) {
    return undefined;
  }
  const parts = [
    `pendingWrites=${diagnostics.pendingWrites}`,
    `queuedBytes=${diagnostics.queuedBytes}`,
    `activeOperation=${diagnostics.activeOperation}`,
    `yieldBeforeWrite=${diagnostics.yieldBeforeWrite}`,
  ];
  if (diagnostics.activeWriteBytes !== undefined) {
    parts.push(`activeWriteBytes=${diagnostics.activeWriteBytes}`);
  }
  if (diagnostics.maxQueuedBytes !== undefined) {
    parts.push(`maxQueuedBytes=${diagnostics.maxQueuedBytes}`);
  }
  if (diagnostics.maxFileBytes !== undefined) {
    parts.push(`maxFileBytes=${diagnostics.maxFileBytes}`);
  }
  return parts.join(" ");
}

function createFileTrajectoryRuntimeSink(writer: TrajectoryRuntimeWriter): TrajectoryRuntimeSink {
  return {
    describeFlushState: () => describeTrajectoryWriterFlushState(writer),
    flush: async () => {
      await writer.flush();
    },
    nextSourceSeq: writer.nextSourceSeq,
    write: (_event, line) => {
      writer.write(`${line}\n`);
    },
  };
}

function createSqliteTrajectoryRuntimeSink(params: {
  env: NodeJS.ProcessEnv;
  maxRuntimeFileBytes: number;
  sessionFile?: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: SessionTranscriptRuntimeTarget;
}): TrajectoryRuntimeSink | null {
  const target = params.sessionTarget
    ? {
        agentId: normalizeOptionalString(params.sessionTarget.agentId),
        sessionId: normalizeOptionalString(params.sessionTarget.sessionId),
        sessionKey: normalizeOptionalString(params.sessionTarget.sessionKey),
        storePath: normalizeOptionalString(params.sessionTarget.storePath),
      }
    : undefined;
  const legacyMarker = parseSqliteSessionFileMarker(params.sessionFile);
  const completeTarget = Boolean(
    target?.agentId && target.sessionId && target.sessionKey && target.storePath,
  );
  const targetKeyAgentId = parseAgentSessionKey(target?.sessionKey)?.agentId;
  const requestedSessionKey = normalizeOptionalString(params.sessionKey);
  const completeTargetKeyEntry =
    completeTarget && target?.agentId && target.sessionKey && target.storePath
      ? loadSessionEntry({
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
        })
      : undefined;
  // A prepared runtime target may precede its metadata row. Treat an absent
  // row as uncommitted, while rejecting an existing conflicting mapping.
  if (
    completeTarget &&
    ((requestedSessionKey && target?.sessionKey !== requestedSessionKey) ||
      (targetKeyAgentId && target?.agentId !== targetKeyAgentId) ||
      (completeTargetKeyEntry && completeTargetKeyEntry.sessionId !== target?.sessionId))
  ) {
    return null;
  }
  const targetKeyEntry =
    target?.sessionKey && legacyMarker && !completeTarget
      ? loadSessionEntry({
          agentId: legacyMarker.agentId,
          sessionKey: target.sessionKey,
          storePath: legacyMarker.storePath,
        })
      : undefined;
  if (
    target &&
    !completeTarget &&
    legacyMarker &&
    ((target.agentId && target.agentId !== legacyMarker.agentId) ||
      (target.sessionId && target.sessionId !== legacyMarker.sessionId) ||
      (targetKeyAgentId && targetKeyAgentId !== legacyMarker.agentId) ||
      (target.sessionKey && targetKeyEntry?.sessionId !== legacyMarker.sessionId) ||
      (target.storePath && path.resolve(target.storePath) !== path.resolve(legacyMarker.storePath)))
  ) {
    return null;
  }
  const marker =
    target?.agentId && target.sessionId && target.sessionKey && target.storePath
      ? {
          agentId: target.agentId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
        }
      : legacyMarker;
  if (!marker || marker.sessionId !== params.sessionId) {
    return null;
  }
  let pendingEvents: TrajectoryEvent[] = [];
  let queuedBytes = 0;
  return {
    describeFlushState: () =>
      pendingEvents.length > 0
        ? `pendingRows=${pendingEvents.length} queuedBytes=${queuedBytes} activeOperation=sqlite-append`
        : undefined,
    flush: async () => {
      if (pendingEvents.length === 0) {
        return;
      }
      const events = pendingEvents;
      pendingEvents = [];
      queuedBytes = 0;
      appendSqliteTrajectoryRuntimeEvents(
        {
          agentId: marker.agentId,
          env: params.env,
          maxRuntimeBytes: params.maxRuntimeFileBytes,
          sessionId: marker.sessionId,
          storePath: marker.storePath,
        },
        events,
      );
    },
    write: (event, line) => {
      pendingEvents.push(event);
      queuedBytes += Buffer.byteLength(line, "utf8") + 1;
    },
  };
}

export function toTrajectoryToolDefinitions(
  tools: ReadonlyArray<{ name?: string; description?: string; parameters?: unknown }>,
): TrajectoryToolDefinition[] {
  return tools
    .flatMap((tool) => {
      const name = tool.name?.trim();
      if (!name) {
        return [];
      }
      return [
        {
          name,
          description: tool.description,
          parameters: sanitizeDiagnosticPayload(limitTrajectoryPayloadValue(tool.parameters)),
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function createTrajectoryRuntimeRecorder(
  params: TrajectoryRuntimeInit,
): TrajectoryRuntimeRecorder | null {
  const env = params.env ?? process.env;
  // Trajectory capture is now default-on. The env var remains as an explicit
  // override so operators can still disable recording with OPENCLAW_TRAJECTORY=0.
  const enabled = parseBooleanValue(env.OPENCLAW_TRAJECTORY) ?? true;
  if (!enabled) {
    return null;
  }

  const maxRuntimeFileBytes = Math.max(
    1,
    Math.floor(params.maxRuntimeFileBytes ?? TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES),
  );
  const sink = params.writer
    ? createFileTrajectoryRuntimeSink(params.writer)
    : createSqliteTrajectoryRuntimeSink({
        env,
        maxRuntimeFileBytes,
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionTarget: params.sessionTarget,
      });
  if (!sink) {
    return null;
  }
  let seq = 0;
  const traceId = params.sessionId;

  const buildEvent = (
    type: string,
    data?: Record<string, unknown>,
  ): { event: TrajectoryEvent; line: string } | undefined => {
    const nextSeq = seq + 1;
    const sourceSeq = sink.nextSourceSeq?.() ?? nextSeq;
    const event: TrajectoryEvent = {
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      traceId,
      source: "runtime",
      type,
      ts: new Date().toISOString(),
      seq: nextSeq,
      sourceSeq,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      runId: params.runId,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      data: data ? sanitizeTrajectoryPayload(data) : undefined,
    };
    const line = safeJsonStringify(event);
    if (!line) {
      return undefined;
    }
    const boundedLine = truncateOversizedTrajectoryEvent(event, line);
    if (!boundedLine) {
      return undefined;
    }
    const boundedEvent = JSON.parse(boundedLine) as TrajectoryEvent;
    seq = nextSeq;
    return { event: boundedEvent, line: boundedLine };
  };

  return {
    enabled: true,
    recordEvent: (type, data) => {
      const built = buildEvent(type, data);
      if (!built) {
        return;
      }
      sink.write(built.event, built.line);
    },
    flush: async () => {
      await sink.flush();
    },
    describeFlushState: () => sink.describeFlushState(),
  };
}
