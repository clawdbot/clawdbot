import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  recoverSessionEntryFromRestartTombstone,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "./session-accessor.js";
import type { InternalSessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createFixture() {
  const root = tempDirs.make("openclaw-session-recovery-");
  const storePath = path.join(root, "sessions.json");
  const sourceKey = "agent:main:dashboard:tombstoned";
  const successorKey = "agent:main:dashboard:recovered";
  const sourceSessionId = "source-session";
  await replaceSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath }, {
    sessionId: sourceSessionId,
    updatedAt: 10,
    pinnedAt: 5,
    pluginOwnerId: "codex",
    mainRestartRecovery: {
      cycleId: "cycle-1",
      revision: 4,
      chargedAttempts: 3,
      tombstone: { reason: "automatic recovery exhausted" },
    },
  } as InternalSessionEntry);
  await replaceTranscriptEvents(
    { agentId: "main", sessionId: sourceSessionId, sessionKey: sourceKey, storePath },
    [
      {
        type: "session",
        version: 3,
        id: sourceSessionId,
        timestamp: "2026-08-12T00:00:00.000Z",
        cwd: root,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-12T00:00:01.000Z",
        message: { role: "user", content: "finish this" },
      },
      {
        type: "message",
        id: "side-branch",
        parentId: "user-1",
        timestamp: "2026-08-12T00:00:02.000Z",
        message: { role: "assistant", content: "preserve the whole transcript" },
      },
      {
        type: "leaf",
        id: "leaf-1",
        parentId: "side-branch",
        timestamp: "2026-08-12T00:00:03.000Z",
        targetId: "user-1",
      },
    ],
  );
  return { root, sourceKey, sourceSessionId, storePath, successorKey };
}

describe("recoverSessionEntryFromRestartTombstone", () => {
  it("copies the full transcript and atomically records the archived successor transition", async () => {
    const fixture = await createFixture();
    const successorEntry = { sessionId: "successor-session", updatedAt: 20, spawnDepth: 0 };
    const params = {
      agentId: "main",
      expected: {
        cycleId: "cycle-1",
        revision: 4,
        sessionId: fixture.sourceSessionId,
        pluginOwnerId: "codex",
      },
      sourceTarget: { canonicalKey: fixture.sourceKey, storeKeys: [fixture.sourceKey] },
      storePath: fixture.storePath,
      successorEntry,
      successorTarget: { canonicalKey: fixture.successorKey, storeKeys: [fixture.successorKey] },
    };

    const created = await recoverSessionEntryFromRestartTombstone(params);
    expect(created).toMatchObject({ status: "created", successorKey: fixture.successorKey });
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.sourceKey,
        storePath: fixture.storePath,
      }),
    ).toMatchObject({
      archivedAt: expect.any(Number),
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 5,
        tombstone: {
          recoveredSessionId: "successor-session",
          recoveredSessionKey: fixture.successorKey,
        },
      },
    });
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.successorKey,
        storePath: fixture.storePath,
      }),
    ).toMatchObject(successorEntry);
    const recoveredEvents = await loadTranscriptEvents({
      agentId: "main",
      sessionId: successorEntry.sessionId,
      sessionKey: fixture.successorKey,
      storePath: fixture.storePath,
    });
    expect(recoveredEvents).toHaveLength(4);
    expect(recoveredEvents[0]).toMatchObject({ type: "session", id: successorEntry.sessionId });
    expect(JSON.stringify(recoveredEvents)).toContain("preserve the whole transcript");

    const repeated = await recoverSessionEntryFromRestartTombstone({
      ...params,
      successorEntry: { sessionId: "unused-session", updatedAt: 30 },
      successorTarget: {
        canonicalKey: "agent:main:dashboard:unused",
        storeKeys: ["agent:main:dashboard:unused"],
      },
    });
    expect(repeated).toMatchObject({
      status: "existing",
      successorKey: fixture.successorKey,
      successorEntry: { sessionId: successorEntry.sessionId },
    });
  });

  it.each([
    { name: "recovery", revision: 3 },
    { name: "lifecycle", revision: 4, lifecycleRevision: "different-generation" },
  ])("does not archive or copy when the $name revision changed", async (expected) => {
    const fixture = await createFixture();
    const result = await recoverSessionEntryFromRestartTombstone({
      agentId: "main",
      expected: {
        cycleId: "cycle-1",
        revision: expected.revision,
        ...(expected.lifecycleRevision ? { lifecycleRevision: expected.lifecycleRevision } : {}),
        sessionId: fixture.sourceSessionId,
        pluginOwnerId: "codex",
      },
      sourceTarget: { canonicalKey: fixture.sourceKey, storeKeys: [fixture.sourceKey] },
      storePath: fixture.storePath,
      successorEntry: { sessionId: "successor-session", updatedAt: 20 },
      successorTarget: { canonicalKey: fixture.successorKey, storeKeys: [fixture.successorKey] },
    });
    expect(result).toEqual({ status: "conflict", reason: "source-changed" });
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.sourceKey,
        storePath: fixture.storePath,
      })?.archivedAt,
    ).toBeUndefined();
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.successorKey,
        storePath: fixture.storePath,
      }),
    ).toBeUndefined();
  });
});
