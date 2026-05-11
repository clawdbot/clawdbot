import fs from "node:fs";
import path from "node:path";
import { sanitizeDiagnosticPayload } from "../agents/payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "../agents/queued-file-writer.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSecrets } from "../logging/redact.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import {
  TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES,
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
  resolveTrajectoryPointerOpenFlags,
} from "./paths.js";
import type { TrajectoryEvent, TrajectoryToolDefinition } from "./types.js";

export {
  TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES,
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
  TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
  resolveTrajectoryPointerOpenFlags,
  safeTrajectorySessionFileName,
} from "./paths.js";

type TrajectoryRuntimeInit = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  maxRuntimeFileBytes?: number;
  runId?: string;
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  writer?: QueuedFileWriter;
};

type TrajectoryRuntimeRecorder = {
  enabled: true;
  filePath: string;
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

const writers = new Map<string, QueuedFileWriter>();
const MAX_TRAJECTORY_WRITERS = 100;
const TRAJECTORY_RUNTIME_TRUNCATION_SENTINEL_RESERVE_BYTES = 2048;
const TRAJECTORY_RUNTIME_DATA_STRING_MAX_CHARS = 32_768;
const TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS = 64;
const TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS = 64;
const TRAJECTORY_RUNTIME_DATA_MAX_DEPTH = 6;

function writeTrajectoryPointerBestEffort(params: {
  filePath: string;
  sessionFile?: string;
  sessionId: string;
}): void {
  if (!params.sessionFile) {
    return;
  }
  const pointerPath = resolveTrajectoryPointerFilePath(params.sessionFile);
  try {
    const pointerDir = path.resolve(path.dirname(pointerPath));
    if (fs.lstatSync(pointerDir).isSymbolicLink()) {
      return;
    }
    try {
      if (fs.lstatSync(pointerPath).isSymbolicLink()) {
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return;
      }
    }
    const fd = fs.openSync(pointerPath, resolveTrajectoryPointerOpenFlags(), 0o600);
    try {
      fs.writeFileSync(
        fd,
        `${JSON.stringify(
          {
            traceSchema: "openclaw-trajectory-pointer",
            schemaVersion: 1,
            sessionId: params.sessionId,
            runtimeFile: params.filePath,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Pointer files are best-effort; the runtime sidecar itself is authoritative.
  }
}

function trimTrajectoryWriterCache(): void {
  while (writers.size >= MAX_TRAJECTORY_WRITERS) {
    const oldestKey = writers.keys().next().value;
    if (!oldestKey) {
      return;
    }
    writers.delete(oldestKey);
  }
}

function truncateOversizedTrajectoryEvent(
  event: TrajectoryEvent,
  line: string,
): string | undefined {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
    return line;
  }
  const truncated = safeJsonStringify({
    ...event,
    data: {
      truncated: true,
      originalBytes: bytes,
      limitBytes: TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
      reason: "trajectory-event-size-limit",
    },
  });
  if (truncated && Buffer.byteLength(truncated, "utf8") <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
    return truncated;
  }
  return undefined;
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
    limited._truncated = truncatedTrajectoryValue("trajectory-object-size-limit", {
      originalKeys: keys.length,
      limitKeys: TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS,
    });
  }
  seen.delete(value);
  return limited;
}

function sanitizeTrajectoryPayload(data: Record<string, unknown>): Record<string, unknown> {
  return redactSecrets(sanitizeDiagnosticPayload(limitTrajectoryPayloadValue(data))) as Record<
    string,
    unknown
  >;
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

  const filePath = resolveTrajectoryFilePath({
    env,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
  });
  if (!params.writer) {
    trimTrajectoryWriterCache();
  }
  const maxRuntimeFileBytes = Math.max(
    1,
    Math.floor(params.maxRuntimeFileBytes ?? TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES),
  );
  const writer =
    params.writer ??
    getQueuedFileWriter(writers, filePath, {
      maxFileBytes: maxRuntimeFileBytes,
      maxQueuedBytes: maxRuntimeFileBytes,
      yieldBeforeWrite: true,
    });
  writeTrajectoryPointerBestEffort({
    filePath,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
  });
  let seq = 0;
  const traceId = params.sessionId;
  const sentinelReserveBytes = Math.min(
    TRAJECTORY_RUNTIME_TRUNCATION_SENTINEL_RESERVE_BYTES,
    Math.floor(maxRuntimeFileBytes / 2),
  );
  const normalEventLimitBytes = Math.max(1, maxRuntimeFileBytes - sentinelReserveBytes);
  let acceptedRuntimeBytes = 0;
  let droppedEvents = 0;
  let droppedEventBytes = 0;
  let captureStopped = false;

  const writeBoundedLine = (line: string, options: { reserveSentinel: boolean }): boolean => {
    const jsonlLine = `${line}\n`;
    const lineBytes = Buffer.byteLength(jsonlLine, "utf8");
    const limitBytes = options.reserveSentinel ? normalEventLimitBytes : maxRuntimeFileBytes;
    if (acceptedRuntimeBytes + lineBytes > limitBytes) {
      captureStopped = true;
      droppedEvents += 1;
      droppedEventBytes += lineBytes;
      return false;
    }
    const result = writer.write(jsonlLine);
    if (result === "dropped") {
      captureStopped = true;
      droppedEvents += 1;
      droppedEventBytes += lineBytes;
      return false;
    }
    acceptedRuntimeBytes += lineBytes;
    return true;
  };

  const buildEventLine = (type: string, data?: Record<string, unknown>): string | undefined => {
    const nextSeq = seq + 1;
    const event: TrajectoryEvent = {
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      traceId,
      source: "runtime",
      type,
      ts: new Date().toISOString(),
      seq: nextSeq,
      sourceSeq: nextSeq,
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
    seq = nextSeq;
    return boundedLine;
  };

  return {
    enabled: true,
    filePath,
    recordEvent: (type, data) => {
      if (captureStopped) {
        droppedEvents += 1;
        return;
      }
      const line = buildEventLine(type, data);
      if (!line) {
        return;
      }
      writeBoundedLine(line, { reserveSentinel: true });
    },
    flush: async () => {
      if (droppedEvents > 0) {
        const line = buildEventLine("trace.truncated", {
          reason: "trajectory-runtime-file-size-limit",
          droppedEvents,
          droppedEventBytes,
          limitBytes: maxRuntimeFileBytes,
        });
        if (line) {
          writeBoundedLine(line, { reserveSentinel: false });
        }
        droppedEvents = 0;
        droppedEventBytes = 0;
      }
      await writer.flush();
      if (!params.writer) {
        writers.delete(filePath);
      }
    },
  };
}
