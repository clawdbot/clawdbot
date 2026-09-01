/**
 * Test helpers for seeding and observing compaction counts in session stores.
 */
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";

export async function seedSessionStore(params: {
  storePath: string;
  sessionKey: string;
  compactionCount: number;
  updatedAt?: number;
}) {
  await replaceSessionEntry({ storePath: params.storePath, sessionKey: params.sessionKey }, {
    sessionId: "session-1",
    updatedAt: params.updatedAt ?? 1_000,
    compactionCount: params.compactionCount,
  } as SessionEntry);
}

export async function readCompactionCount(storePath: string, sessionKey: string): Promise<number> {
  return loadSessionEntry({ storePath, sessionKey })?.compactionCount ?? 0;
}
