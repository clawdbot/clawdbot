/**
 * Test helpers for seeding and observing compaction counts in session stores.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  readSessionStoreForTest,
  writeSessionStoreForTestAsync,
} from "../config/sessions/test-helpers.js";

export async function seedSessionStore(params: {
  storePath: string;
  sessionKey: string;
  compactionCount: number;
  updatedAt?: number;
}) {
  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  await writeSessionStoreForTestAsync(params.storePath, {
    [params.sessionKey]: {
      sessionId: "session-1",
      updatedAt: params.updatedAt ?? 1_000,
      compactionCount: params.compactionCount,
    },
  });
}

export async function readCompactionCount(storePath: string, sessionKey: string): Promise<number> {
  const store = readSessionStoreForTest<{ compactionCount?: number }>(storePath);
  return store[sessionKey]?.compactionCount ?? 0;
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
