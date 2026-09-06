// Log tail helpers read recent log lines with optional parsing and redaction.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../infra/errno.js";
import { readFileWindowFully } from "../infra/file-read.js";
import { clamp } from "../utils.js";
import { isRollingLogFilePath, isSameRollingLogFileFamily } from "./log-file-path.js";
import "./logger.js";
import { getResolvedLoggerFileTarget } from "./logger-settings-internal.js";
import { parseLogLine, type ParsedLogLine } from "./parse-log-line.js";
import { redactSensitiveLines, resolveRedactOptions } from "./redact.js";

// Tail reader for the active log file, with cursor reset and line redaction.
const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_BYTES = 250_000;
const MAX_LIMIT = 5000;
const MAX_BYTES = 1_000_000;
// Follow validation fingerprints the entire bounded tail window, not just its edge samples.
export const LOG_GENERATION_WINDOW_BYTES = MAX_BYTES;
type LogTailLimit = number | "all";
type LogFileStat = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};
type LogSliceParams = {
  file: string;
  cursor?: number;
  limit: LogTailLimit;
  maxBytes: number;
  filter?: (line: string) => boolean;
  forceReset?: boolean;
};

function missingPathToNull(error: unknown): null {
  if (!isMissingPathError(error)) {
    throw error;
  }
  return null;
}

function getContentWindowBounds(cursor: number, size: number) {
  const end = Math.min(Math.max(0, cursor), size);
  const start = Math.max(0, end - LOG_GENERATION_WINDOW_BYTES);
  return { start, length: end - start };
}

/** Payload returned to log-tail callers with cursor and truncation metadata. */
export type LogTailPayload = {
  file: string;
  cursor: number;
  size: number;
  lines: string[];
  truncated: boolean;
  reset: boolean;
  skippedBytes?: number;
};

/** File identity and content samples captured by the handle used for a tail read. */
export type LogFileGeneration = {
  identity: string;
  size: number;
  prefix: string;
  prefixLength: number;
  boundary: string;
  contentHash: string;
  contentWindowStart: number;
  contentWindowLength: number;
  mtimeNs: string;
  ctimeNs: string;
};

/** Redacted configured log tail with only parseable structured records. */
type LogTailReadPayload = LogTailPayload & {
  generation?: LogFileGeneration;
  generationStable?: boolean;
};
type ParsedLogTailPayload = Omit<LogTailPayload, "lines"> & {
  lines: ParsedLogLine[];
  generation?: LogFileGeneration;
  generationStable?: boolean;
};

/** Resolves a rolling daily log path to the newest existing rolling log when needed. */
async function resolveLogFile(file: string, options?: { rolling?: boolean }): Promise<string> {
  const stat = await fs.stat(file).catch(missingPathToNull);
  if (stat) {
    return file;
  }
  if (!(options?.rolling ?? isRollingLogFilePath(file))) {
    return file;
  }

  const dir = path.dirname(file);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(missingPathToNull);
  if (!entries) {
    return file;
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && isSameRollingLogFileFamily(file, entry.name))
      .map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        const fileStat = await fs.stat(fullPath).catch(missingPathToNull);
        return fileStat ? { path: fullPath, mtimeMs: fileStat.mtimeMs } : null;
      }),
  );
  const sorted = candidates
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  return sorted[0]?.path ?? file;
}

async function readLogSlice(params: LogSliceParams): Promise<Omit<LogTailReadPayload, "file">> {
  const handle = await fs.open(params.file, "r").catch(missingPathToNull);
  if (!handle) {
    return {
      cursor: 0,
      size: 0,
      lines: [],
      truncated: false,
      reset: false,
    };
  }
  try {
    let lastResult: Omit<LogTailReadPayload, "file"> | undefined;
    let retryParams = params;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stat = (await handle.stat({ bigint: true })) as LogFileStat;
      const result = await readLogSliceAttempt(retryParams, handle, stat);
      lastResult = result;
      const finalStat = (await handle.stat({ bigint: true })) as LogFileStat;
      if (
        isSameLogFileStat(stat, finalStat) ||
        (await isStableLogSlice(handle, stat, finalStat, result, retryParams.forceReset === true))
      ) {
        return result;
      }
      if (result.reset && result.skippedBytes === undefined) {
        // Preserve a shrink/rotation re-anchor if the file grows again before the retry.
        retryParams = { ...params, cursor: undefined, forceReset: true };
      }
    }
    return {
      ...(lastResult as Omit<LogTailReadPayload, "file">),
      generationStable: false,
    };
  } finally {
    await handle.close();
  }
}

function isSameLogFileStat(left: LogFileStat, right: LogFileStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

// An append can race the read without changing consumed bytes; validate that bounded snapshot
// instead of requiring an idle file, while preserving shrink re-anchors for callers.
async function isStableLogSlice(
  handle: Awaited<ReturnType<typeof fs.open>>,
  initialStat: LogFileStat,
  finalStat: LogFileStat,
  result: Omit<LogTailReadPayload, "file">,
  forcedReset: boolean,
): Promise<boolean> {
  if (
    initialStat.dev !== finalStat.dev ||
    initialStat.ino !== finalStat.ino ||
    finalStat.size < initialStat.size ||
    (!forcedReset && result.reset && result.skippedBytes === undefined) ||
    result.generation === undefined
  ) {
    return false;
  }

  const generation = result.generation;
  const readWindow = async (start: number, length: number) => {
    const buffer = Buffer.alloc(Math.max(0, length));
    const bytesRead = await readFileWindowFully(handle, buffer, start);
    return buffer.subarray(0, bytesRead);
  };
  const prefix = await readWindow(0, generation.prefixLength);
  if (!prefix.equals(Buffer.from(generation.prefix, "base64"))) {
    return false;
  }

  const content = await readWindow(generation.contentWindowStart, generation.contentWindowLength);
  if (
    content.length !== generation.contentWindowLength ||
    createHash("sha256").update(content).digest("hex") !== generation.contentHash
  ) {
    return false;
  }

  const cursor = generation.contentWindowStart + generation.contentWindowLength;
  const boundaryStart = Math.max(0, cursor - 64);
  const boundary = await readWindow(boundaryStart, cursor - boundaryStart);
  return boundary.equals(Buffer.from(generation.boundary, "base64"));
}

async function readLogSliceAttempt(
  params: LogSliceParams,
  handle: Awaited<ReturnType<typeof fs.open>>,
  stat: LogFileStat,
): Promise<Omit<LogTailReadPayload, "file">> {
  const size = Number(stat.size);
  const maxBytes = clamp(params.maxBytes, 1, MAX_BYTES);
  const limit = params.limit === "all" ? undefined : clamp(params.limit, 1, MAX_LIMIT);
  let cursor =
    typeof params.cursor === "number" && Number.isFinite(params.cursor)
      ? Math.max(0, Math.floor(params.cursor))
      : undefined;
  let reset = params.forceReset === true;
  let skippedBytes: number | undefined;
  let truncated = false;
  let start;

  if (cursor != null) {
    if (cursor > size) {
      // File rotated or shrank since the previous cursor; restart near the end.
      reset = true;
      start = Math.max(0, size - maxBytes);
      truncated = start > 0;
    } else {
      start = cursor;
      if (size - start > maxBytes) {
        // Keep reset as the re-anchor signal for existing clients. The skipped byte count
        // lets current clients distinguish this valid-cursor fast-forward from file shrink.
        reset = true;
        truncated = true;
        const boundedStart = Math.max(0, size - maxBytes);
        skippedBytes = boundedStart - start;
        start = boundedStart;
      }
    }
  } else {
    start = Math.max(0, size - maxBytes);
    truncated = start > 0;
  }

  const readBytes = async (windowStart: number, length: number) => {
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - windowStart)));
    const bytesRead = await readFileWindowFully(handle, buffer, windowStart);
    return buffer.subarray(0, bytesRead);
  };
  // Capture the generation before reading returned records so a rewrite cannot replace its
  // fingerprint after the output buffer was produced.
  const prefixLength = Math.min(64, size);
  const prefixSnapshot = await readBytes(0, prefixLength);
  const generationSnapshotStart = Math.max(0, size - LOG_GENERATION_WINDOW_BYTES);
  const generationSnapshot = await readBytes(
    generationSnapshotStart,
    size - generationSnapshotStart,
  );
  const buildGeneration = (generationCursor: number): LogFileGeneration | undefined => {
    if (
      prefixSnapshot.length !== prefixLength ||
      generationSnapshot.length !== size - generationSnapshotStart
    ) {
      return undefined;
    }
    const boundedCursor = Math.min(Math.max(0, generationCursor), size);
    const boundaryStart = Math.max(0, boundedCursor - 64);
    const contentWindow = getContentWindowBounds(boundedCursor, size);
    const sliceSnapshot = (windowStart: number, length: number) => {
      const offset = windowStart - generationSnapshotStart;
      if (offset < 0 || offset + length > generationSnapshot.length) {
        return undefined;
      }
      return generationSnapshot.subarray(offset, offset + length);
    };
    const contentBuffer = sliceSnapshot(contentWindow.start, contentWindow.length);
    const boundary = sliceSnapshot(boundaryStart, boundedCursor - boundaryStart);
    if (contentBuffer === undefined || boundary === undefined) {
      return undefined;
    }
    return {
      identity: `${stat.dev}:${stat.ino}`,
      size,
      prefix: prefixSnapshot.toString("base64"),
      prefixLength,
      boundary: boundary.toString("base64"),
      contentHash: createHash("sha256").update(contentBuffer).digest("hex"),
      contentWindowStart: contentWindow.start,
      contentWindowLength: contentBuffer.length,
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    };
  };

  if (size === 0 || size <= start) {
    return {
      cursor: size,
      size,
      lines: [],
      truncated,
      reset,
      skippedBytes,
      generation: buildGeneration(size),
    };
  }

  let prefix = "";
  if (start > 0) {
    const prefixBuf = Buffer.alloc(1);
    const prefixRead = await handle.read(prefixBuf, 0, 1, start - 1);
    prefix = prefixBuf.toString("utf8", 0, prefixRead.bytesRead);
  }

  const length = Math.max(0, size - start);
  const buffer = Buffer.alloc(length);
  const bytesRead = await readFileWindowFully(handle, buffer, start);
  const text = buffer.toString("utf8", 0, bytesRead);
  let lines = text.split("\n");
  lines.pop();
  if (start > 0 && prefix !== "\n") {
    // Drop the first partial line when starting in the middle of a file.
    lines.shift();
  }
  if (params.filter) {
    // Sparse consumers inspect the full byte-bounded window before the shared line cap.
    lines = lines.filter(params.filter);
  }
  if (limit !== undefined && lines.length > limit) {
    truncated = true;
    lines = lines.slice(lines.length - limit);
  }

  // Keep an unterminated record pending so a later read can emit it whole.
  const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
  cursor = text.endsWith("\n") ? size : start + lastNewline + 1;

  return {
    cursor,
    size,
    lines,
    truncated,
    reset,
    skippedBytes,
    generation: buildGeneration(cursor),
  };
}

async function readConfiguredLogTailInternal(
  params?: { cursor?: number; limit?: LogTailLimit; maxBytes?: number },
  filter?: (line: string) => boolean,
): Promise<LogTailReadPayload> {
  const target = getResolvedLoggerFileTarget();
  const file = await resolveLogFile(target.file, { rolling: target.rolling });
  const result = await readLogSlice({
    file,
    cursor: params?.cursor,
    limit: params?.limit ?? DEFAULT_LIMIT,
    maxBytes: params?.maxBytes ?? DEFAULT_MAX_BYTES,
    filter,
  });
  const redaction = resolveRedactOptions();
  return {
    file,
    ...result,
    lines: redactSensitiveLines(result.lines, redaction),
  };
}

/** Reads and redacts the configured log tail with bounded bytes and line count. */
export async function readConfiguredLogTail(
  params?: { cursor?: number; limit?: LogTailLimit; maxBytes?: number },
  filter?: (line: string) => boolean,
): Promise<LogTailPayload> {
  const tail = await readConfiguredLogTailInternal(params, filter);
  const { generation: _generation, generationStable: _generationStable, ...publicTail } = tail;
  return publicTail;
}

/** Reads the canonical configured tail and parses its already-redacted lines. */
export async function readConfiguredParsedLogTail(params?: {
  cursor?: number;
  limit?: LogTailLimit;
  maxBytes?: number;
  filter?: (line: Pick<ParsedLogLine, "subsystem" | "module" | "plugin">) => boolean;
}): Promise<ParsedLogTailPayload> {
  const tail = await readConfiguredLogTailInternal(params, (raw) => {
    const parsed = parseLogLine(raw);
    return parsed !== null && (params?.filter?.(parsed) ?? true);
  });
  return {
    ...tail,
    lines: tail.lines.flatMap((line) => {
      const parsed = parseLogLine(line);
      return parsed ? [parsed] : [];
    }),
  };
}
