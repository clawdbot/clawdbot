// Copies safe transcript tails across session lifecycle rotations.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "./version.js";

/** Tail kept so DM continuity survives silent session rotations. */
const DEFAULT_REPLAY_MAX_MESSAGES = 6;

type SessionRecord = {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown };
};
type KeptRecord = { role: "user" | "assistant"; line: string };
type KeptParsedRecord = { role: "user" | "assistant"; record: unknown };

function isValidReplayTimestamp(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return typeof value === "string" && value.trim().length > 0;
}

function replayableRole(record: SessionRecord | null): "user" | "assistant" | undefined {
  if (
    !record ||
    record.type !== "message" ||
    typeof record.id !== "string" ||
    record.id.trim().length === 0 ||
    !isValidReplayTimestamp(record.timestamp) ||
    !(
      record.parentId === null ||
      record.parentId === undefined ||
      typeof record.parentId === "string"
    )
  ) {
    return undefined;
  }
  const role = record.message?.role;
  return role === "user" || role === "assistant" ? role : undefined;
}

/**
 * Copy the tail of user/assistant JSONL records from a prior transcript into a
 * freshly-rotated one. Tool, system, and compaction records are skipped so
 * replay cannot reshape tool/role ordering, and the tail is aligned and
 * coalesced into alternating user/assistant turns so role-ordering resets
 * cannot immediately recur. Uses async I/O so long transcripts do not block
 * the event loop. Returns 0 on any error.
 */
export async function replayRecentUserAssistantMessages(params: {
  sourceTranscript?: string;
  targetTranscript: string;
  newSessionId: string;
  maxMessages?: number;
}): Promise<number> {
  const max = Math.max(0, params.maxMessages ?? DEFAULT_REPLAY_MAX_MESSAGES);
  const src = params.sourceTranscript;
  if (max === 0 || !src || !fs.existsSync(src)) {
    return 0;
  }
  try {
    const tail = await readRecentUserAssistantReplayLines({
      sourceTranscript: src,
      maxMessages: max,
    });
    if (tail.length === 0) {
      return 0;
    }
    if (!fs.existsSync(params.targetTranscript)) {
      await fsp.mkdir(path.dirname(params.targetTranscript), { recursive: true });
      const header = JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.newSessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      });
      await fsp.writeFile(params.targetTranscript, `${header}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
    }
    await fsp.appendFile(params.targetTranscript, `${tail.join("\n")}\n`, "utf-8");
    return tail.length;
  } catch {
    return 0;
  }
}

export async function readRecentUserAssistantReplayRecordsFromJsonl(params: {
  sourceTranscript?: string;
  maxMessages?: number;
}): Promise<unknown[]> {
  const max = Math.max(0, params.maxMessages ?? DEFAULT_REPLAY_MAX_MESSAGES);
  const src = params.sourceTranscript;
  if (max === 0 || !src || !fs.existsSync(src)) {
    return [];
  }
  const records: unknown[] = [];
  for (const line of (await fsp.readFile(src, "utf-8")).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line) as unknown);
    } catch {
      // Skip malformed lines.
    }
  }
  return selectRecentUserAssistantReplayRecords(records, max);
}

export function selectRecentUserAssistantReplayRecords(
  records: readonly unknown[],
  maxMessages = DEFAULT_REPLAY_MAX_MESSAGES,
): unknown[] {
  const max = Math.max(0, maxMessages);
  if (max === 0) {
    return [];
  }
  const kept: KeptParsedRecord[] = [];
  for (const record of records) {
    const role = replayableRole(record as SessionRecord | null);
    if (role) {
      kept.push({ role, record });
    }
  }
  const tail = selectAlternatingReplayTail(kept, max);
  return tail.map((entry) => entry.record);
}

async function readRecentUserAssistantReplayLines(params: {
  sourceTranscript: string;
  maxMessages: number;
}): Promise<string[]> {
  const kept: KeptRecord[] = [];
  for (const line of (await fsp.readFile(params.sourceTranscript, "utf-8")).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const role = replayableRole(JSON.parse(line) as SessionRecord | null);
      if (role) {
        kept.push({ role, line });
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return selectAlternatingReplayTail(kept, params.maxMessages).map((entry) => entry.line);
}

function selectAlternatingReplayTail<T extends { role: "user" | "assistant" }>(
  kept: T[],
  max: number,
): T[] {
  if (kept.length === 0) {
    return [];
  }
  let startIdx = Math.max(0, kept.length - max);
  while (startIdx < kept.length && kept[startIdx]?.role === "assistant") {
    startIdx += 1;
  }
  if (startIdx === kept.length) {
    // Retained window is assistant-only; replaying would re-create the same
    // role-ordering hazard this reset path is recovering from.
    return [];
  }
  return coalesceAlternatingReplayTail(kept.slice(startIdx));
}

// Keep the newest record from each same-role run, preserving original JSONL bytes
// for replay while ensuring strict provider alternation.
function coalesceAlternatingReplayTail<T extends { role: "user" | "assistant" }>(
  entries: T[],
): T[] {
  const tail: T[] = [];
  for (const entry of entries) {
    const lastIdx = tail.length - 1;
    if (lastIdx >= 0 && tail[lastIdx]?.role === entry.role) {
      tail[lastIdx] = entry;
      continue;
    }
    tail.push(entry);
  }
  return tail;
}
