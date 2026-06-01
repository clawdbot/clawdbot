import fs from "node:fs/promises";
import path from "node:path";
import { readPositiveIntEnv } from "./env-limits.mjs";

export type SessionLogMentionLimits = {
  fileMaxBytes: number;
  totalMaxBytes: number;
};

export type SessionLogNeedles = Record<string, string>;

const DEFAULT_FILE_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TOTAL_MAX_BYTES = 16 * 1024 * 1024;

export function readSessionLogMentionLimits(
  env: NodeJS.ProcessEnv = process.env,
): SessionLogMentionLimits {
  return {
    fileMaxBytes: readPositiveIntEnv(
      "OPENCLAW_SESSION_LOG_MENTION_FILE_MAX_BYTES",
      DEFAULT_FILE_MAX_BYTES,
      env,
    ),
    totalMaxBytes: readPositiveIntEnv(
      "OPENCLAW_SESSION_LOG_MENTION_TOTAL_MAX_BYTES",
      DEFAULT_TOTAL_MAX_BYTES,
      env,
    ),
  };
}

function taggedError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  for (;;) {
    const next = haystack.indexOf(needle, offset);
    if (next < 0) {
      return count;
    }
    count += 1;
    offset = next + needle.length;
  }
}

function createCounts(needles: SessionLogNeedles): Record<string, number> {
  return Object.fromEntries(Object.keys(needles).map((key) => [key, 0]));
}

function recordRole(record: unknown): string | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const candidate = record as { message?: unknown; role?: unknown };
  if (typeof candidate.role === "string") {
    return candidate.role;
  }
  if (!candidate.message || typeof candidate.message !== "object") {
    return undefined;
  }
  const message = candidate.message as { role?: unknown };
  return typeof message.role === "string" ? message.role : undefined;
}

function shouldScanSessionLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return recordRole(JSON.parse(trimmed)) !== "user";
  } catch {
    return true;
  }
}

function assertWithinLimit(params: {
  byteCount: number;
  filePath?: string;
  label: string;
  limit: number;
}) {
  if (params.byteCount <= params.limit) {
    return;
  }
  const source = params.filePath ? ` ${params.filePath}` : "";
  throw taggedError(
    `session log mention scan exceeded ${params.label} limit${source}: ${params.byteCount} > ${params.limit}`,
    "ETOOBIG",
  );
}

export async function countSessionLogMentions(params: {
  limits?: SessionLogMentionLimits;
  needles: SessionLogNeedles;
  sessionsDir: string;
}): Promise<Record<string, number>> {
  const limits = params.limits ?? readSessionLogMentionLimits();
  const counts = createCounts(params.needles);
  let files: string[];
  try {
    files = await fs.readdir(params.sessionsDir);
  } catch {
    return counts;
  }

  let totalBytes = 0;
  for (const file of files.filter((candidate) => candidate.endsWith(".jsonl")).toSorted()) {
    const filePath = path.join(params.sessionsDir, file);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    assertWithinLimit({
      byteCount: stat.size,
      filePath,
      label: "per-file",
      limit: limits.fileMaxBytes,
    });
    totalBytes += stat.size;
    assertWithinLimit({
      byteCount: totalBytes,
      label: "total",
      limit: limits.totalMaxBytes,
    });

    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    const actualBytes = Buffer.byteLength(raw, "utf8");
    assertWithinLimit({
      byteCount: actualBytes,
      filePath,
      label: "per-file",
      limit: limits.fileMaxBytes,
    });
    for (const line of raw.split(/\r?\n/u)) {
      if (!shouldScanSessionLogLine(line)) {
        continue;
      }
      for (const [key, needle] of Object.entries(params.needles)) {
        counts[key] += countOccurrences(line, needle);
      }
    }
  }
  return counts;
}
