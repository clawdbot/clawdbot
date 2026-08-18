// Regression coverage for the atomic transcript-snapshot capture described in #124393:
// after a synchronous append, SessionManager must record its "last known good" snapshot
// from inside the append's own write transaction (via onCommittedSnapshot), never by
// rereading storage afterward. A post-commit reread would leave a window in which a
// foreign process's append lands between that commit and the reread and is silently
// absorbed into the "expected" snapshot, so a later rewrite could delete it without
// ever detecting the conflict.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

describe("SessionManager transcript snapshot race regression (#124393)", () => {
  it("never rereads the transcript snapshot after a synchronous append", async () => {
    const dir = tempDirs.make("openclaw-session-manager-snapshot-race-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "snapshot-race-no-reread";
    const sessionKey = "agent:main:dashboard:snapshot-race-no-reread";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await sessionAccessor.upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionFile: marker, sessionId, updatedAt: 10 },
    );
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question" },
    });

    const target = parseSqliteSessionFileMarker(marker);
    if (!target) {
      throw new Error("expected SQLite transcript marker fixture");
    }
    const manager = SessionManager.open({ ...target, sessionKey }, dir);

    const rereadSpy = vi.spyOn(sessionAccessor, "readTranscriptSnapshotSync");
    const callsAfterOpen = rereadSpy.mock.calls.length;

    manager.appendMessage(buildAssistantMessage("first answer"));
    manager.appendMessage(buildAssistantMessage("second answer"));

    // The buggy version reread the snapshot from storage after every append
    // (SessionManagerCore#refreshTranscriptSnapshot). The fix records it atomically
    // from inside the append's own transaction instead, so no additional reread call
    // should ever happen here.
    expect(rereadSpy.mock.calls.length).toBe(callsAfterOpen);

    rereadSpy.mockRestore();
  });

  it("rejects a rewrite when a foreign process commits right after our own last append", async () => {
    const dir = tempDirs.make("openclaw-session-manager-snapshot-race-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "snapshot-race-conflict";
    const sessionKey = "agent:main:dashboard:snapshot-race-conflict";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await sessionAccessor.upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionFile: marker, sessionId, updatedAt: 10 },
    );
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question" },
    });

    const target = parseSqliteSessionFileMarker(marker);
    if (!target) {
      throw new Error("expected SQLite transcript marker fixture");
    }
    const manager = SessionManager.open({ ...target, sessionKey }, dir);

    // Our own append. Its committed snapshot is now tracked in-memory, captured
    // atomically from inside its own write transaction.
    const ownAnswerId = manager.appendMessage(buildAssistantMessage("own answer"));

    // A foreign process (a different SessionManager instance, a different runner, a
    // crashed-and-restarted process, etc.) commits its own append to the same
    // transcript immediately afterward, without this manager ever observing it.
    const foreignAppend = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "foreign-message",
      message: buildAssistantMessage("foreign answer"),
      parentId: ownAnswerId,
    });

    // A rewrite (e.g. discarding a trailing entry to retry) must detect that the
    // durable transcript has moved past our last known snapshot instead of silently
    // rewriting over -- and deleting -- the foreign commit.
    expect(() => manager.removeTrailingEntries((entry) => entry.id === ownAnswerId)).toThrow(
      expect.objectContaining({ name: "SqliteTranscriptMutationConflictError" }),
    );

    const records = await loadTranscriptEvents(scope);
    const ids = records
      .map((record) =>
        record && typeof record === "object" && "id" in record ? record.id : undefined,
      )
      .filter((id): id is string => typeof id === "string");
    expect(ids).toContain(foreignAppend.messageId);
    expect(ids).toContain(ownAnswerId);

    // After the refused rewrite, the manager resynced with the durable foreign row
    // instead of pretending it never happened.
    expect(manager.getLeafId()).toBe(foreignAppend.messageId);
  });

  it("captures the load snapshot atomically with loaded events on open (#124393 follow-up)", async () => {
    // setSessionTarget()/SessionManager.open() used to load entries via
    // loadTranscriptEventsSync and then separately refresh the row snapshot via
    // readTranscriptSnapshotSync. A foreign process's commit landing in that gap was
    // absent from the loaded entries but present in the "expected" snapshot, so a
    // later rewrite would validate against it and silently delete the foreign row.
    // The fix loads both from a single loadTranscriptEventsWithSnapshotSync read
    // transaction; this asserts that combined path is what actually runs.
    const dir = tempDirs.make("openclaw-session-manager-snapshot-race-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "snapshot-race-atomic-load";
    const sessionKey = "agent:main:dashboard:snapshot-race-atomic-load";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await sessionAccessor.upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionFile: marker, sessionId, updatedAt: 10 },
    );
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question" },
    });

    const target = parseSqliteSessionFileMarker(marker);
    if (!target) {
      throw new Error("expected SQLite transcript marker fixture");
    }

    const combinedReadSpy = vi.spyOn(sessionAccessor, "loadTranscriptEventsWithSnapshotSync");
    const separateEntriesReadSpy = vi.spyOn(sessionAccessor, "loadTranscriptEventsSync");
    const separateSnapshotReadSpy = vi.spyOn(sessionAccessor, "readTranscriptSnapshotSync");

    SessionManager.open({ ...target, sessionKey }, dir);

    // Entries and the row snapshot must both come from the one combined read; the old
    // separate-call helpers must never run during open(), or the load-boundary race
    // this test guards against would be reintroduced.
    expect(combinedReadSpy).toHaveBeenCalledTimes(1);
    expect(separateEntriesReadSpy).not.toHaveBeenCalled();
    expect(separateSnapshotReadSpy).not.toHaveBeenCalled();

    combinedReadSpy.mockRestore();
    separateEntriesReadSpy.mockRestore();
    separateSnapshotReadSpy.mockRestore();
  });

  it("rejects a rewrite when a foreign process commits right before our own next append", async () => {
    // Regression for the clawsweeper[bot] P1 finding on PR #124749: a foreign row
    // committed after this manager's last known snapshot but before its *own* next
    // append must not be silently absorbed into the "known-good" snapshot that a
    // later rewrite validates against -- that would let the rewrite delete it.
    const dir = tempDirs.make("openclaw-session-manager-snapshot-race-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "snapshot-race-foreign-before-own-append";
    const sessionKey = "agent:main:dashboard:snapshot-race-foreign-before-own-append";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await sessionAccessor.upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionFile: marker, sessionId, updatedAt: 10 },
    );
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question" },
    });

    const target = parseSqliteSessionFileMarker(marker);
    if (!target) {
      throw new Error("expected SQLite transcript marker fixture");
    }
    const manager = SessionManager.open({ ...target, sessionKey }, dir);

    // A foreign process commits its own append *before* this manager's next append,
    // without this manager ever observing it.
    const foreignAppend = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "foreign-message",
      message: buildAssistantMessage("foreign answer"),
      parentId: user.messageId,
    });

    // This manager's own append must still succeed -- the foreign row must not block
    // it -- but it must not record a "known-good" snapshot that absorbed the foreign
    // row without ever adding it to this manager's own in-memory entries. A non-message
    // append (appendThinkingLevelChange, like any other leaf/opaque append) goes
    // through appendTranscriptEventSync, which -- unlike a message append -- has no
    // effectiveParentId reconciliation that would otherwise reload and resync the
    // manager on its own.
    manager.appendThinkingLevelChange("high");

    // A rewrite must now detect that its tracked snapshot is stale (because the
    // append above could not safely refresh it) instead of proceeding to overwrite
    // storage with entries that omit the foreign row.
    expect(() =>
      manager.removeTrailingEntries((entry) => entry.type === "thinking_level_change"),
    ).toThrow(expect.objectContaining({ name: "SqliteTranscriptMutationConflictError" }));

    const records = await loadTranscriptEvents(scope);
    const ids = records
      .map((record) =>
        record && typeof record === "object" && "id" in record ? record.id : undefined,
      )
      .filter((id): id is string => typeof id === "string");
    expect(ids).toContain(foreignAppend.messageId);
  });
});
