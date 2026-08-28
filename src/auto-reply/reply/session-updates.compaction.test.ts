import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { incrementCompactionCount } from "./session-updates.js";

// Regression coverage for the canonical-primitives fix in
// `incrementCompactionCount` (replaces the b82fd65c00 shape that dropped
// `mergeSessionEntry` semantics + the `activeSessionKey` preserve-from-prune opt).
//
// These tests exercise the load-bearing edges via real fs:
//   1. First-turn manual /compact: in-memory session has an entry but the
//      on-disk store is fresh (no entry yet). The persist must merge-or-create
//      from the active in-memory entry rather than silently dropping the count.
//   2. sessionId rollover during compaction: the canonical merge primitive
//      rolls `sessionStartedAt` to the new-session epoch when sessionId
//      changes (existing.sessionId !== sessionId), which a raw spread would
//      not do.
//
// Tests for monotonic-`updatedAt` under concurrent-compaction races and
// activeSessionKey-preserve-from-enforce-mode-prune are queued for a follow-up
// pass — they require concurrent-write simulation and enforce-mode trigger
// staging that's beyond this PR's scope. The current fix uses the same
// canonical primitives those scenarios depend on (mergeSessionEntry +
// `{ activeSessionKey }`), so the structural protection is in place even
// though the targeted tests are deferred.

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

  it("persists count on first-turn /compact when on-disk store has no entry yet", async () => {
    const sessionKey = "test:first-turn-compact";
    const inMemoryEntry: SessionEntry = {
      sessionId: "session-A",
      compactionCount: 0,
      updatedAt: 1_000_000,
      sessionStartedAt: 900_000,
    };
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: inMemoryEntry,
    };

    // Sanity: store path must not yet exist — this IS the first-turn case.
    expect(loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })).toBeUndefined();

    const result = await incrementCompactionCount({
      sessionStore,
      sessionKey,
      storePath,
      now: 2_000_000,
    });

    // Count returned to caller.
    expect(result).toBe(1);

    // In-memory entry advanced.
    expect(sessionStore[sessionKey]?.compactionCount).toBe(1);

    // On-disk store now has the entry. (b82fd65c00's `updateSessionStoreEntry`
    // call was a no-op here because the existing-entry check returned null;
    // count was silently dropped on disk. The canonical-primitives fix
    // merge-or-creates from the active in-memory entry.)
    const persisted = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
    expect(persisted).toBeDefined();
    expect(persisted?.compactionCount).toBe(1);
    expect(persisted?.sessionId).toBe("session-A");
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
