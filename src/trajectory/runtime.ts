// Trajectory runtime records runtime events into trajectory log files.
import fs from "node:fs";
import path from "node:path";
import { sanitizeDiagnosticPayload } from "../agents/payload-redaction.js";
import type {
  QueuedFileWriter,
  QueuedFileWriterDiagnostics,
} from "../agents/queued-file-writer.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertNoSymlinkParents, writeSiblingTempFile } from "../infra/fs-safe-advanced.js";
import { readRegularFileSync } from "../infra/fs-safe.js";
import { redactSecrets } from "../logging/redact.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import {
  TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES,
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
  TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
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
  writer?: TrajectoryRuntimeWriter;
};

type TrajectoryRuntimeRecorder = {
  enabled: true;
  filePath: string;
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
  describeFlushState: () => string | undefined;
};

const writers = new Map<string, TrajectoryRuntimeWriter>();
const windowFlushes = new Map<string, Promise<void>>();
const MAX_TRAJECTORY_WRITERS = 100;
const TRAJECTORY_RUNTIME_DATA_STRING_MAX_CHARS = 32_768;
const TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS = 64;
const TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS = 64;
const TRAJECTORY_RUNTIME_DATA_MAX_DEPTH = 6;

type TrajectoryRuntimeWriterDiagnostics = Omit<QueuedFileWriterDiagnostics, "activeOperation"> & {
  activeOperation: QueuedFileWriterDiagnostics["activeOperation"] | "file-replace";
};

type TrajectoryRuntimeWriter = Omit<QueuedFileWriter, "describeQueue"> & {
  describeQueue?: () => TrajectoryRuntimeWriterDiagnostics;
  nextSourceSeq?: () => number;
};

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
    limited["_truncated"] = truncatedTrajectoryValue("trajectory-object-size-limit", {
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

function trimJsonlWindow(lines: string[], maxBytes: number): number {
  let bytes = 0;
  for (const line of lines) {
    bytes += Buffer.byteLength(line, "utf8");
  }
  while (bytes > maxBytes && lines.length > 0) {
    const line = lines.shift();
    if (line !== undefined) {
      bytes -= Buffer.byteLength(line, "utf8");
    }
  }
  return bytes;
}

function compareTrajectoryWindowLines(left: string, right: string): number {
  const leftEvent = parseTrajectoryWindowLine(left);
  const rightEvent = parseTrajectoryWindowLine(right);
  const byTs = leftEvent.ts - rightEvent.ts;
  if (byTs !== 0) {
    return byTs;
  }
  return leftEvent.seq - rightEvent.seq;
}

function parseTrajectoryWindowLine(line: string): { ts: number; seq: number } {
  try {
    const parsed = JSON.parse(line) as { ts?: unknown; sourceSeq?: unknown; seq?: unknown };
    const ts = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : Number.POSITIVE_INFINITY;
    const sourceSeq = typeof parsed.sourceSeq === "number" ? parsed.sourceSeq : undefined;
    const seq = typeof parsed.seq === "number" ? parsed.seq : undefined;
    return {
      ts: Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY,
      seq: sourceSeq ?? seq ?? Number.POSITIVE_INFINITY,
    };
  } catch {
    return { ts: Number.POSITIVE_INFINITY, seq: Number.POSITIVE_INFINITY };
  }
}

function readMaxTrajectorySourceSeq(filePath: string): number {
  return readTrajectoryWindowLines(filePath, TRAJECTORY_RUNTIME_FILE_MAX_BYTES).reduce(
    (max, line) => {
      try {
        const parsed = JSON.parse(line) as { sourceSeq?: unknown; seq?: unknown };
        const seq =
          typeof parsed.sourceSeq === "number"
            ? parsed.sourceSeq
            : typeof parsed.seq === "number"
              ? parsed.seq
              : 0;
        return Math.max(max, seq);
      } catch {
        return max;
      }
    },
    0,
  );
}

function readTrajectoryWindowLines(filePath: string, maxBytes: number): string[] {
  try {
    const raw = readRegularFileSync({
      filePath,
      maxBytes: TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
    }).buffer.toString("utf8");
    const lines = raw
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line) => `${line}\n`);
    trimJsonlWindow(lines, maxBytes);
    return lines;
  } catch {
    return [];
  }
}

async function replaceTrajectoryWindow(params: {
  filePath: string;
  maxFileBytes: number;
  appendedLines: string[];
}): Promise<void> {
  const dir = path.dirname(params.filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkParents({
    rootDir: path.parse(path.resolve(dir)).root,
    targetPath: path.resolve(dir),
    allowMissing: false,
    allowRootChildSymlink: true,
    requireDirectories: true,
    messagePrefix: "Refusing to write trajectory under",
  });
  const lines = readTrajectoryWindowLines(params.filePath, params.maxFileBytes);
  lines.push(...params.appendedLines);
  lines.sort(compareTrajectoryWindowLines);
  trimJsonlWindow(lines, params.maxFileBytes);
  await writeSiblingTempFile({
    dir,
    chmodDir: false,
    mode: 0o600,
    tempPrefix: ".openclaw-trajectory-",
    writeTemp: async (tempPath) => {
      await fs.promises.writeFile(tempPath, lines.join(""), {
        encoding: "utf8",
        mode: 0o600,
      });
    },
    resolveFinalPath: () => params.filePath,
  });
}

async function queueTrajectoryWindowFlush(params: {
  filePath: string;
  maxFileBytes: number;
  appendedLines: string[];
}): Promise<void> {
  const previous = windowFlushes.get(params.filePath) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      await replaceTrajectoryWindow(params);
    })
    .finally(() => {
      if (windowFlushes.get(params.filePath) === current) {
        windowFlushes.delete(params.filePath);
      }
    });
  windowFlushes.set(params.filePath, current);
  await current;
}

function createTrajectoryWindowWriter(
  filePath: string,
  maxFileBytes: number,
): TrajectoryRuntimeWriter {
  let pendingLines: string[] = [];
  let queuedBytes = 0;
  let pendingWrites = 0;
  let activeOperation: TrajectoryRuntimeWriterDiagnostics["activeOperation"] = "idle";
  let queue: Promise<unknown> = Promise.resolve();
  let sourceSeq = readMaxTrajectorySourceSeq(filePath);

  return {
    filePath,
    write: (line) => {
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (lineBytes > maxFileBytes) {
        return "dropped";
      }
      pendingLines.push(line);
      queuedBytes += lineBytes;
      queuedBytes = trimJsonlWindow(pendingLines, maxFileBytes);
      pendingWrites = 1;
      return "queued";
    },
    flush: async () => {
      if (pendingLines.length === 0) {
        await queue;
        return;
      }
      const appendedLines = pendingLines;
      pendingLines = [];
      queuedBytes = 0;
      queue = queue
        .then(async () => {
          activeOperation = "file-replace";
          await queueTrajectoryWindowFlush({
            filePath,
            maxFileBytes,
            appendedLines,
          });
        })
        .catch(() => undefined)
        .finally(() => {
          pendingWrites = pendingLines.length > 0 ? 1 : 0;
          activeOperation = "idle";
        });
      await queue;
    },
    describeQueue: () => ({
      pendingWrites,
      queuedBytes,
      activeOperation,
      maxFileBytes,
      maxQueuedBytes: maxFileBytes,
      yieldBeforeWrite: false,
    }),
    nextSourceSeq: () => {
      sourceSeq += 1;
      return sourceSeq;
    },
  };
}

function getTrajectoryWindowWriter(
  filePath: string,
  maxFileBytes: number,
): TrajectoryRuntimeWriter {
  const existing = writers.get(filePath);
  if (existing) {
    return existing;
  }
  trimTrajectoryWriterCache();
  const writer = createTrajectoryWindowWriter(filePath, maxFileBytes);
  writers.set(filePath, writer);
  return writer;
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
  const maxRuntimeFileBytes = Math.max(
    1,
    Math.floor(params.maxRuntimeFileBytes ?? TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES),
  );
  const writer = params.writer ?? getTrajectoryWindowWriter(filePath, maxRuntimeFileBytes);
  writeTrajectoryPointerBestEffort({
    filePath,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
  });
  let seq = 0;
  const traceId = params.sessionId;

  const writeBoundedLine = (line: string): void => {
    const jsonlLine = `${line}\n`;
    writer.write(jsonlLine);
  };

  const buildEventLine = (type: string, data?: Record<string, unknown>): string | undefined => {
    const nextSeq = seq + 1;
    const sourceSeq = writer.nextSourceSeq?.() ?? nextSeq;
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
    seq = nextSeq;
    return boundedLine;
  };

  return {
    enabled: true,
    filePath,
    recordEvent: (type, data) => {
      const line = buildEventLine(type, data);
      if (!line) {
        return;
      }
      writeBoundedLine(line);
    },
    flush: async () => {
      await writer.flush();
    },
    describeFlushState: () => describeTrajectoryWriterFlushState(writer),
  };
}
