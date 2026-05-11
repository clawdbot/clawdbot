import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

/** Tail kept so DM continuity survives silent session rotations. */
export const DEFAULT_REPLAY_MAX_MESSAGES = 6;

type SessionRecord = { message?: { role?: unknown } };
type KeptRecord = { role: "user" | "assistant"; line: string };

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
    const kept: KeptRecord[] = [];
    for (const line of (await fsp.readFile(src, "utf-8")).split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const role = (JSON.parse(line) as SessionRecord | null)?.message?.role;
        if (role === "user" || role === "assistant") {
          kept.push({ role, line });
        }
      } catch {
        // Skip malformed lines.
      }
    }
    if (kept.length === 0) {
      return 0;
    }
    let startIdx = Math.max(0, kept.length - max);
    while (startIdx < kept.length && kept[startIdx].role === "assistant") {
      startIdx += 1;
    }
    if (startIdx === kept.length) {
      // Retained window is assistant-only; replaying would re-create the same
      // role-ordering hazard this reset path is recovering from.
      return 0;
    }
    const tail = coalesceAlternatingReplayTail(kept.slice(startIdx)).map((entry) => entry.line);
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

// Keep the newest record from each same-role run, preserving original JSONL bytes
// for replay while ensuring strict provider alternation.
function coalesceAlternatingReplayTail(entries: KeptRecord[]): KeptRecord[] {
  const tail: KeptRecord[] = [];
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
