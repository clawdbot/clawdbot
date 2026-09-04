// Branch replacement keeps the live manager and durable identity on the same commit edge.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  onSessionIdentityMutation,
  replaceTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("SessionManager branch replacement", () => {
  it.each(["memory", "sqlite"])(
    "preserves opaque parents and labels in a %s branch",
    async (mode) => {
      const dir = tempDirs.make("openclaw-session-manager-branch-");
      const scope = {
        agentId: "main",
        sessionId: "source-session",
        sessionKey: "agent:main:branch-labels",
        storePath: path.join(dir, "sessions.json"),
      };
      const entries = [
        { type: "session", version: CURRENT_SESSION_VERSION, id: scope.sessionId, cwd: dir },
        {
          type: "message",
          id: "user",
          parentId: null,
          message: { role: "user", content: "question" },
        },
        { type: "future-metadata", id: "opaque", parentId: "user", details: { value: "retained" } },
        {
          type: "message",
          id: "reply",
          parentId: "opaque",
          message: { role: "user", content: "reply" },
        },
        {
          type: "label",
          id: "label",
          parentId: "reply",
          targetId: "user",
          label: "named",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          type: "message",
          id: "abandoned",
          parentId: "label",
          message: { role: "user", content: "excluded" },
        },
      ];
      if (mode === "sqlite") {
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        replaceTranscriptEventsSync(scope, entries);
      }
      const manager =
        mode === "sqlite" ? SessionManager.open(scope, dir) : SessionManager.fromEntries(entries);

      const branchId = await manager.createBranchedSession("reply");
      const expected = [
        expect.objectContaining({ id: manager.getSessionId(), type: "session" }),
        entries[1],
        entries[2],
        entries[3],
        expect.objectContaining({ ...entries[4], id: expect.any(String) }),
      ];
      expect(manager.getSessionId()).not.toBe(scope.sessionId);
      expect(manager.getPersistedEntries()).toEqual(expected);
      expect(manager.getLabel("user")).toBe("named");
      expect(manager.getEntry("abandoned")).toBeUndefined();
      if (mode === "sqlite") {
        expect(branchId).toBe(manager.getSessionId());
        expect(await loadTranscriptEvents(scope)).toEqual(entries);
        expect(
          SessionManager.open({ ...scope, sessionId: branchId! }).getPersistedEntries(),
        ).toEqual(expected);
      } else {
        expect(branchId).toBeUndefined();
        expect(manager.getSessionTarget()).toBeUndefined();
      }
    },
  );

  it("creates SQLite-backed branch sessions without rewriting the source transcript", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-branch-source";
    const sessionKey = "agent:main:dashboard:sqlite-branch-source";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        delivery: { kind: "internal" },
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question before branch" },
    });
    const assistant = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "assistant-message",
      message: { role: "assistant", content: [{ type: "text", text: "answer before branch" }] },
      parentId: user.messageId,
    });

    const sessionManager = SessionManager.open(scope, dir);
    const observedBranches: unknown[] = [];
    const stop = onSessionIdentityMutation((mutation) => {
      if (mutation.kind !== "replace" || !mutation.current.sessionKeys.includes(sessionKey)) {
        return;
      }
      observedBranches.push({
        sessionId: sessionManager.getSessionId(),
        target: sessionManager.getSessionTarget(),
        durableEntries: SessionManager.open({
          ...scope,
          sessionId: mutation.current.sessionId!,
        }).getEntries(),
      });
    });
    let branchedMarker: string | undefined;
    try {
      branchedMarker = await sessionManager.createBranchedSession(assistant.messageId);
    } finally {
      stop();
    }
    const branchedSessionId = sessionManager.getSessionId();

    expect(branchedMarker).toBe(branchedSessionId);
    expect(branchedSessionId).not.toBe(sessionId);
    expect(observedBranches).toEqual([
      {
        sessionId: branchedSessionId,
        target: { ...scope, sessionId: branchedSessionId },
        durableEntries: sessionManager.getEntries(),
      },
    ]);
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
      delivery: { kind: "internal" },
      sessionId: branchedSessionId,
    });
    await expect(loadTranscriptEvents({ agentId: "main", sessionId, storePath })).resolves.toEqual([
      expect.objectContaining({ id: sessionId, type: "session" }),
      expect.objectContaining({ id: user.messageId, type: "message" }),
      expect.objectContaining({ id: assistant.messageId, type: "message" }),
    ]);
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: branchedSessionId,
        sessionKey,
        storePath,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: branchedSessionId,
        parentSession: sessionId,
        type: "session",
      }),
      expect.objectContaining({ id: user.messageId, type: "message" }),
      expect.objectContaining({ id: assistant.messageId, type: "message" }),
    ]);
  });

  it("does not publish a branch identity when transcript persistence fails", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const scope = {
      agentId: "main",
      sessionId: "branch-write-failure",
      sessionKey: "agent:main:branch-write-failure",
      storePath: path.join(dir, "sessions.json"),
    };
    const manager = SessionManager.open(scope, dir);
    const leafId = manager.appendMessage({ role: "user", content: "source", timestamp: 1 });
    const beforeEntry = loadSessionEntry(scope);
    const beforeEvents = await loadTranscriptEvents(scope);
    const beforeEntries = manager.getEntries();
    const database = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath(scope),
    });
    database.db.exec(`
      CREATE TRIGGER reject_branch_transcript BEFORE INSERT ON transcript_events
      BEGIN SELECT RAISE(ABORT, 'branch transcript write failed'); END;
    `);
    const replacements: unknown[] = [];
    const stop = onSessionIdentityMutation((mutation) => {
      if (mutation.previous.sessionKeys.includes(scope.sessionKey)) {
        replacements.push(mutation);
      }
    });
    try {
      await expect(manager.createBranchedSession(leafId)).rejects.toThrow(
        "branch transcript write failed",
      );
    } finally {
      stop();
    }

    expect(loadSessionEntry(scope)).toEqual(beforeEntry);
    expect(await loadTranscriptEvents(scope)).toEqual(beforeEvents);
    expect(manager.getSessionId()).toBe(scope.sessionId);
    expect(manager.getSessionTarget()).toEqual(scope);
    expect(manager.getEntries()).toEqual(beforeEntries);
    expect(manager.getLeafId()).toBe(leafId);
    expect(replacements).toEqual([]);
  });

  it.each(["lifecycle", "writer", "metadata", "guarded-target", "successor-writer"])(
    "revalidates queued %s changes before branching",
    async (change) => {
      const dir = tempDirs.make("openclaw-session-manager-");
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "sqlite-branch-race-source";
      const sessionKey = "agent:main:dashboard:sqlite-branch-race-source";
      const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
      const scope = { agentId: "main", sessionId, sessionKey, storePath };
      await upsertSessionEntryCore(scope, {
        activeWriterRunId: "branch-original-writer",
        lifecycleRevision: "branch-original-revision",
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      });
      const user = await appendTranscriptMessage(scope, {
        cwd: dir,
        eventId: "branch-race-user",
        message: { role: "user", content: "question before raced branch" },
      });
      const assistant = await appendTranscriptMessage(scope, {
        cwd: dir,
        eventId: "branch-race-assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "answer before raced branch" }],
        },
        parentId: user.messageId,
      });
      const sessionManager = SessionManager.open(scope, dir);
      const runAsWriter = <T>(run: () => Promise<T>) =>
        withOwnedSessionTranscriptWrites(
          {
            sessionTarget: {
              ...scope,
              expectedLifecycleRevision: "branch-original-revision",
              expectedWriterRunId: "branch-original-writer",
            },
            ...(change === "guarded-target" ? { assertCommitAllowed: () => {} } : {}),
            withTranscriptWrite: async (operation) => await operation(),
          },
          run,
        );
      if (change === "successor-writer") {
        await runAsWriter(() => sessionManager.createBranchedSession(assistant.messageId));
      }
      const branchSourceId = sessionManager.getSessionId();
      const readManagerState = () => ({
        entries: sessionManager.getEntries(),
        sessionId: sessionManager.getSessionId(),
        target: sessionManager.getSessionTarget(),
        leafId: sessionManager.getLeafId(),
        appendParentId: sessionManager.getAppendParentId(),
      });
      const beforeBranch = readManagerState();
      const writerChanged = change === "writer" || change === "successor-writer";
      let releaseOwnerChange = () => {};
      const ownerChangeGate = new Promise<void>((resolve) => {
        releaseOwnerChange = resolve;
      });
      let markOwnerChangeStarted = () => {};
      const ownerChangeStarted = new Promise<void>((resolve) => {
        markOwnerChangeStarted = resolve;
      });
      const ownerChange = updateSessionEntry(scope, async () => {
        markOwnerChangeStarted();
        await ownerChangeGate;
        return change === "lifecycle"
          ? { lifecycleRevision: "branch-replacement-revision" }
          : writerChanged
            ? { activeWriterRunId: "branch-replacement-writer" }
            : { label: "updated while branch queued" };
      });
      await ownerChangeStarted;

      const queuedAt = Date.now();
      const committedAt = queuedAt + 1_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(queuedAt);
      const branch = runAsWriter(() => sessionManager.createBranchedSession(assistant.messageId));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const whileQueued = readManagerState();
      clock.mockReturnValue(committedAt);
      releaseOwnerChange();

      await ownerChange;
      if (change === "lifecycle") {
        await expect(branch).rejects.toMatchObject({
          cause: { code: "session-rebound", expectedSessionId: sessionId, sessionKey },
        });
        expect(loadSessionEntry(scope)).toMatchObject({
          lifecycleRevision: "branch-replacement-revision",
          sessionId,
        });
        expect(sessionManager.getSessionId()).toBe(sessionId);
      } else if (writerChanged || change === "guarded-target") {
        await expect(branch).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
        expect(loadSessionEntry(scope)).toMatchObject({
          sessionId: branchSourceId,
          lifecycleRevision: "branch-original-revision",
          activeWriterRunId: writerChanged ? "branch-replacement-writer" : "branch-original-writer",
        });
        if (change === "successor-writer") {
          expect(() =>
            sessionManager.appendMessage({
              role: "user",
              content: "stale successor append",
              timestamp: committedAt,
            }),
          ).toThrow(SessionTranscriptWriterClaimReboundError);
        }
        expect(readManagerState()).toEqual(beforeBranch);
      } else {
        const branchId = await branch;
        expect(loadSessionEntry(scope)).toMatchObject({
          label: "updated while branch queued",
          sessionId: branchId,
          updatedAt: committedAt,
          activeWriterRunId: "branch-original-writer",
        });
        expect(sessionManager.getSessionId()).toBe(branchId);
      }
      expect(whileQueued).toEqual(beforeBranch);
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ id: sessionId, type: "session" }),
        expect.objectContaining({ id: user.messageId, type: "message" }),
        expect.objectContaining({ id: assistant.messageId, type: "message" }),
      ]);
    },
  );
});
