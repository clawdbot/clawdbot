// Log tail helpers read recent log lines with optional parsing and redaction.
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
type LogTailLimit = number | "all";

function missingPathToNull(error: unknown): null {
  if (!isMissingPathError(error)) {
    throw error;
  }
  return null;
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
  generation?: LogFileGeneration;
};

/** File identity and content samples captured by the handle used for a tail read. */
export type LogFileGeneration = {
  identity: string;
  prefix: string;
  prefixLength: number;
  boundary: string;
  mtimeNs: string;
  ctimeNs: string;
};

/** Redacted configured log tail with only parseable structured records. */
type ParsedLogTailPayload = Omit<LogTailPayload, "lines"> & {
  lines: ParsedLogLine[];
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

async function readLogSlice(params: {
  file: string;
  cursor?: number;
  limit: LogTailLimit;
  maxBytes: number;
  filter?: (line: string) => boolean;
}): Promise<Omit<LogTailPayload, "file">> {
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
    const stat = await handle.stat({ bigint: true });
    const size = Number(stat.size);
    const maxBytes = clamp(params.maxBytes, 1, MAX_BYTES);
    const limit = params.limit === "all" ? undefined : clamp(params.limit, 1, MAX_LIMIT);
    let cursor =
      typeof params.cursor === "number" && Number.isFinite(params.cursor)
        ? Math.max(0, Math.floor(params.cursor))
        : undefined;
    let reset = false;
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

    const readWindow = async (windowStart: number, length: number) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - windowStart)));
      const bytesRead = await readFileWindowFully(handle, buffer, windowStart);
      return buffer.toString("base64", 0, bytesRead);
    };
    const buildGeneration = async (generationCursor: number): Promise<LogFileGeneration> => {
      const boundedCursor = Math.min(Math.max(0, generationCursor), size);
      const prefixLength = Math.min(64, size);
      const boundaryStart = Math.max(0, boundedCursor - 64);
      return {
        identity: `${stat.dev}:${stat.ino}`,
        prefix: await readWindow(0, prefixLength),
        prefixLength,
        boundary: await readWindow(boundaryStart, boundedCursor - boundaryStart),
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
        generation: await buildGeneration(size),
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
      generation: await buildGeneration(cursor),
    };
  } finally {
    await handle.close();
  }
}

/** Reads and redacts the configured log tail with bounded bytes and line count. */
export async function readConfiguredLogTail(
  params?: { cursor?: number; limit?: LogTailLimit; maxBytes?: number },
  filter?: (line: string) => boolean,
): Promise<LogTailPayload> {
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

/** Reads the canonical configured tail and parses its already-redacted lines. */
export async function readConfiguredParsedLogTail(params?: {
  cursor?: number;
  limit?: LogTailLimit;
  maxBytes?: number;
  filter?: (line: Pick<ParsedLogLine, "subsystem" | "module" | "plugin">) => boolean;
}): Promise<ParsedLogTailPayload> {
  const tail = await readConfiguredLogTail(params, (raw) => {
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
