import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { incrementCompactionCount } from "./session-updates.js";

describe("incrementCompactionCount canonical-primitives fix", () => {
  let tmp: string;
  let storePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "openclaw-incr-compaction-"));
    storePath = join(tmp, "sessions.json");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rolls sessionStartedAt to new-session epoch when sessionId changes during compaction", async () => {
    const sessionKey = "test:sessionid-rollover";
    // Use realistic timestamps because mergeSessionEntry's resolveMergedUpdatedAt
    // monotonically clamps to Date.now() — that's the protection against
    // backward time-travel. The test assertion is relational: sessionStartedAt
    // rolls to the new-session updatedAt (NOT the prior sessionStartedAt).
    const oldSessionStartedAt = Date.now() - 60_000;
    const inMemoryEntry: SessionEntry = {
      sessionId: "session-old",
      compactionCount: 2,
      updatedAt: Date.now() - 30_000,
      sessionStartedAt: oldSessionStartedAt,
    };
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: inMemoryEntry,
    };
    await replaceSessionEntry({ storePath, sessionKey }, inMemoryEntry);

    const compactionMoment = Date.now();
    await incrementCompactionCount({
      sessionStore,
      sessionKey,
      storePath,
      now: compactionMoment,
      newSessionId: "session-new",
    });

    // Canonical mergeSessionEntry rolls sessionStartedAt to the resolved
    // updatedAt when sessionId changes. Raw spread would have kept the prior
    // sessionStartedAt unchanged. Relational assertion: rolled forward AND
    // distinct from the pre-rollover value.
    const inMem = sessionStore[sessionKey];
    expect(inMem?.sessionId).toBe("session-new");
    expect(inMem?.sessionStartedAt).toBeGreaterThanOrEqual(compactionMoment);
    expect(inMem?.sessionStartedAt).not.toBe(oldSessionStartedAt);
    expect(inMem?.sessionStartedAt).toBe(inMem?.updatedAt);

    // The on-disk merge is a SEPARATE invocation of mergeSessionEntry inside
    // the disk lock (resolves against any concurrent writer's state). Its
    // resolved updatedAt may differ from in-memory by milliseconds, so assert
    // disk-side rollover invariants independently rather than equating the
    // two timestamps.
    const persisted = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
    expect(persisted?.sessionId).toBe("session-new");
    expect(persisted?.sessionStartedAt).toBeGreaterThanOrEqual(compactionMoment);
    expect(persisted?.sessionStartedAt).not.toBe(oldSessionStartedAt);
    expect(persisted?.sessionStartedAt).toBe(persisted?.updatedAt);
  });

  it("merges count across multiple compactions when on-disk entry already exists", async () => {
    const sessionKey = "test:merge-existing";
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId: "session-X",
        compactionCount: 0,
        updatedAt: 1_000_000,
        sessionStartedAt: 1_000_000,
      },
    };
    await replaceSessionEntry({ storePath, sessionKey }, sessionStore[sessionKey]!);

    await incrementCompactionCount({
      sessionStore,
      sessionKey,
      storePath,
      now: 2_000_000,
    });
    await incrementCompactionCount({
      sessionStore,
      sessionKey,
      storePath,
      now: 3_000_000,
    });

    expect(sessionStore[sessionKey]?.compactionCount).toBe(2);
    const persisted = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
    expect(persisted?.compactionCount).toBe(2);
    // sessionStartedAt should remain the same (sessionId did not change).
    expect(persisted?.sessionStartedAt).toBe(1_000_000);
  });
});
