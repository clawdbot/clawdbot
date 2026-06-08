// Test fixtures create isolated agent/session store directories for session tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { loadSessionStore } from "./store-load.js";
import { closeSqliteSessionStoreDatabase, replaceSqliteSessionStore } from "./store-sqlite.js";
import { clearSessionStoreCacheForTest } from "./store-writer-state.js";
import type { SessionEntry } from "./types.js";

/** Creates and cleans a temporary session store fixture around each test. */
export function useTempSessionsFixture(prefix: string) {
  let tempDir = "";
  let storePath = "";
  let sessionsDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    storePath = path.join(sessionsDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    storePath: () => storePath,
    sessionsDir: () => sessionsDir,
  };
}

export function writeSessionStoreForTest(storePath: string, store: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.rmSync(storePath, { force: true });
  clearSessionStoreCacheForTest();
  replaceSqliteSessionStore(storePath, store as Record<string, SessionEntry>);
  closeSqliteSessionStoreDatabase(storePath);
  clearSessionStoreCacheForTest();
}

export async function writeSessionStoreForTestAsync(
  storePath: string,
  store: Record<string, unknown>,
): Promise<void> {
  writeSessionStoreForTest(storePath, store);
}

export function readSessionStoreForTest<T extends object = SessionEntry>(
  storePath: string,
): Record<string, T> {
  try {
    return loadSessionStore(storePath, { skipCache: true }) as Record<string, T>;
  } finally {
    closeSqliteSessionStoreDatabase(storePath);
  }
}
