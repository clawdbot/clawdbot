// SQLite branch persistence regressions split from session-manager.test.ts (max-lines).
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function openMarker(marker: string, sessionKey: string, cwd: string): SessionManager {
  const target = parseSqliteSessionFileMarker(marker);
  if (!target) {
    throw new Error("expected SQLite transcript marker fixture");
  }
  return SessionManager.open({ ...target, sessionKey }, cwd);
}

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

describe("SessionManager SQLite branch persistence", () => {
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
      message: buildAssistantMessage("answer before branch"),
      parentId: user.messageId,
    });

    const sessionManager = openMarker(marker, sessionKey, dir);
    const branchedMarker = await sessionManager.createBranchedSession(assistant.messageId);
    const branchedSessionId = sessionManager.getSessionId();

    expect(branchedMarker).toBe(branchedSessionId);
    expect(branchedSessionId).not.toBe(sessionId);
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
    expect(() => sessionManager.prepareTranscriptRewrite()).not.toThrow();

    expect(sessionManager.removeTrailingEntries((entry) => entry.id === assistant.messageId)).toBe(
      1,
    );
    expect(() => sessionManager.prepareTranscriptRewrite()).not.toThrow();
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: branchedSessionId,
        sessionKey,
        storePath,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: branchedSessionId, type: "session" }),
      expect.objectContaining({ id: user.messageId, type: "message" }),
    ]);
  });

  it("rejects a queued branch when lifecycle ownership changes before persistence", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-branch-race-source";
    const sessionKey = "agent:main:dashboard:sqlite-branch-race-source";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, {
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
      message: buildAssistantMessage("answer before raced branch"),
      parentId: user.messageId,
    });
    const sessionManager = openMarker(marker, sessionKey, dir);

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
      return { lifecycleRevision: "branch-replacement-revision" };
    });
    await ownerChangeStarted;

    const branch = sessionManager.createBranchedSession(assistant.messageId);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    releaseOwnerChange();

    await ownerChange;
    await expect(branch).rejects.toMatchObject({
      cause: {
        code: "session-rebound",
        expectedSessionId: sessionId,
        sessionKey,
      },
    });
    expect(loadSessionEntry(scope)).toMatchObject({
      lifecycleRevision: "branch-replacement-revision",
      sessionId,
    });
    expect(sessionManager.getSessionId()).toBe(sessionId);
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ id: sessionId, type: "session" }),
      expect.objectContaining({ id: user.messageId, type: "message" }),
      expect.objectContaining({ id: assistant.messageId, type: "message" }),
    ]);
  });
});
