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

export async function waitForCompactionCount(params: {
  storePath: string;
  sessionKey: string;
  expected: number;
}) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await readCompactionCount(params.storePath, params.sessionKey)) === params.expected) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for compactionCount=${params.expected}`);
}
