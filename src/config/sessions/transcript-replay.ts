// Selects safe user/assistant tails for in-log lifecycle boundaries.

/** Tail kept so DM continuity survives silent session rotations. */
export const DEFAULT_REPLAY_MAX_MESSAGES = 6;

type SessionRecord = {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown };
};
type KeptParsedRecord = { role: "user" | "assistant"; record: unknown };

function isValidReplayTimestamp(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return typeof value === "string" && value.trim().length > 0;
}

export function replayableTranscriptRole(
  record: SessionRecord | null,
): "user" | "assistant" | undefined {
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
    const role = replayableTranscriptRole(record as SessionRecord | null);
    if (role) {
      kept.push({ role, record });
    }
  }
  const tail = selectAlternatingReplayTail(kept, max);
  return tail.map((entry) => entry.record);
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
