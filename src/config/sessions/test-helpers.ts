// Test fixtures create isolated agent/session store directories for session tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { applySessionEntryLifecycleMutation, replaceSessionEntry } from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";

/** Creates and cleans a temporary session store fixture around each test. */
export function useTempSessionsFixture(prefix: string) {
  let tempDir = "";
  let storePath = "";
  let sessionsDir = "";

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    storePath = path.join(sessionsDir, "sessions.json");
  });

  afterEach(async () => {
    await cleanupSessionStateForTest({ stateDir: tempDir });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    storePath: () => storePath,
    sessionsDir: () => sessionsDir,
  };
}

export async function runByteLimitedArchiveCleanupFixture(storePath: string): Promise<string[]> {
  const sessionIds = ["worker-byte-session-0", "worker-byte-session-1"];
  const largeContent = "x".repeat(33 * 1024 * 1024);
  for (const [index, sessionId] of sessionIds.entries()) {
    const sessionKey = `agent:main:hook:worker-byte-${index}`;
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: index });
    await replaceTranscriptEvents({ sessionId, sessionKey, storePath }, [
      { content: `${index}:${largeContent}`, id: sessionId, type: "session" },
    ]);
  }
  await replaceSessionEntry(
    { sessionKey: "agent:main:worker-byte-retained", storePath },
    { sessionId: "worker-byte-session-retained", updatedAt: Date.now() },
  );
  await applySessionEntryLifecycleMutation({
    storePath,
    maintenanceOverride: {
      maxEntries: 100,
      mode: "enforce",
      pruneAfterMs: 60_000,
    },
  });
  return sessionIds;
}
