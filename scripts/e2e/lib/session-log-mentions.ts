// Session Log Mentions script supports OpenClaw repository automation.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readPositiveIntEnv } from "./env-limits.mjs";

type SessionLogMentionLimits = {
  fileMaxBytes: number;
  totalMaxBytes: number;
};

type SessionLogNeedles = Record<string, string>;

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

function collectStringLeaves(value: unknown, output: string[]) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringLeaves(item, output);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const item of Object.values(value)) {
    collectStringLeaves(item, output);
  }
}

function sessionLogScanText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const record = JSON.parse(trimmed) as unknown;
    if (recordRole(record) === "user") {
      return null;
    }
    const strings: string[] = [];
    collectStringLeaves(record, strings);
    return strings.join("\n");
  } catch {
    return line;
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
  const addCounts = (nextCounts: Record<string, number>) => {
    for (const [key, count] of Object.entries(nextCounts)) {
      counts[key] = (counts[key] ?? 0) + count;
    }
  };
  let files: string[];
  try {
    files = await fs.readdir(params.sessionsDir);
  } catch {
    files = [];
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
      const scanText = sessionLogScanText(line);
      if (scanText === null) {
        continue;
      }
      for (const [key, needle] of Object.entries(params.needles)) {
        counts[key] = (counts[key] ?? 0) + countOccurrences(scanText, needle);
      }
    }
  }
  addCounts(
    await countSqliteTranscriptMentions({
      limits,
      needles: params.needles,
      sessionsDir: params.sessionsDir,
      startingBytes: totalBytes,
    }),
  );
  return counts;
}

function resolveAgentSqlitePathFromSessionsDir(sessionsDir: string): string | null {
  if (path.basename(sessionsDir) !== "sessions") {
    return null;
  }
  return path.join(path.dirname(sessionsDir), "agent", "openclaw-agent.sqlite");
}

async function countSqliteTranscriptMentions(params: {
  limits: SessionLogMentionLimits;
  needles: SessionLogNeedles;
  sessionsDir: string;
  startingBytes: number;
}): Promise<Record<string, number>> {
  const counts = createCounts(params.needles);
  const sqlitePath = resolveAgentSqlitePathFromSessionsDir(params.sessionsDir);
  if (!sqlitePath) {
    return counts;
  }
  const stat = await fs.stat(sqlitePath).catch(() => null);
  if (!stat?.isFile()) {
    return counts;
  }
  let totalBytes = params.startingBytes;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(sqlitePath, { readOnly: true });
    const hasTranscriptEvents = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcript_events'")
      .get();
    if (!hasTranscriptEvents) {
      return counts;
    }
    const rows = db.prepare("SELECT event_json FROM transcript_events ORDER BY session_id, seq");
    for (const row of rows.iterate() as Iterable<{ event_json?: unknown }>) {
      if (typeof row.event_json !== "string") {
        continue;
      }
      const byteCount = Buffer.byteLength(row.event_json, "utf8");
      assertWithinLimit({
        byteCount,
        filePath: sqlitePath,
        label: "per-file",
        limit: params.limits.fileMaxBytes,
      });
      totalBytes += byteCount;
      assertWithinLimit({
        byteCount: totalBytes,
        label: "total",
        limit: params.limits.totalMaxBytes,
      });
      const scanText = sessionLogScanText(row.event_json);
      if (scanText === null) {
        continue;
      }
      for (const [key, needle] of Object.entries(params.needles)) {
        counts[key] = (counts[key] ?? 0) + countOccurrences(scanText, needle);
      }
    }
    return counts;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      throw error;
    }
    return counts;
  } finally {
    db?.close();
  }
}
