// Session manager tests cover SQLite persistence and in-memory tree behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  readTranscriptRawDelta,
  replaceTranscriptEventsSync,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as Logger from "../../logger.js";
import {
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
  type SessionMessageEntry,
} from "./session-manager.js";

const tempPaths: string[] = [];

function openMarker(marker: string, sessionKey: string, cwd: string): SessionManager {
  const target = parseSqliteSessionFileMarker(marker);
  if (!target) {
    throw new Error("expected SQLite transcript marker fixture");
  }
  return SessionManager.open({ ...target, sessionKey }, cwd);
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-manager-"));
  tempPaths.push(dir);
  return dir;
}

describe("SessionManager.open", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("opens SQLite markers without creating marker-named files and persists assistant replies", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-session";
    const sessionKey = "agent:main:dashboard:sqlite";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        cwd: dir,
        message: { role: "user", content: "question" },
      },
    );

    const sessionManager = openMarker(marker, sessionKey, dir);
    expect(sessionManager.buildSessionContext().messages).toEqual([
      expect.objectContaining({ content: "question", role: "user" }),
    ]);

    const assistantId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const thinkingChangeId = sessionManager.appendThinkingLevelChange("high");
    const modelChangeId = sessionManager.appendModelChange("openai", "gpt-5.5");
    const compactionId = sessionManager.appendCompaction("summary", "assistant-1", 42);
    const resetId = sessionManager.appendResetBoundary("new", assistantId);
    expect(sessionManager.getBoundaryCount()).toBe(2);

    await expect(fs.stat(path.join(process.cwd(), marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      loadTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }),
    ).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({
        message: expect.objectContaining({ content: "question", role: "user" }),
        type: "message",
      }),
      expect.objectContaining({
        id: assistantId,
        parentId: expect.any(String),
        message: expect.objectContaining({
          content: [{ type: "text", text: "answer" }],
          role: "assistant",
        }),
        type: "message",
      }),
      expect.objectContaining({
        id: thinkingChangeId,
        thinkingLevel: "high",
        type: "thinking_level_change",
      }),
      expect.objectContaining({
        id: modelChangeId,
        modelId: "gpt-5.5",
        provider: "openai",
        type: "model_change",
      }),
      expect.objectContaining({
        firstKeptEntryId: "assistant-1",
        id: compactionId,
        summary: "summary",
        type: "compaction",
      }),
      expect.objectContaining({
        firstKeptEntryId: assistantId,
        id: resetId,
        reason: "new",
        type: "reset",
      }),
    ]);
    const reopened = openMarker(marker, sessionKey, dir);
    expect(reopened.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: thinkingChangeId, type: "thinking_level_change" }),
        expect.objectContaining({ id: modelChangeId, type: "model_change" }),
        expect.objectContaining({ id: compactionId, type: "compaction" }),
        expect.objectContaining({ id: resetId, type: "reset" }),
      ]),
    );
  });

  it("persists explicit leaf controls across SQLite reopen", async () => {
    const dir = await makeTempDir();
    const scope = {
      agentId: "main",
      sessionId: "sqlite-leaf-control",
      sessionKey: "agent:main:dashboard:sqlite-leaf-control",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    const manager = SessionManager.open(scope, dir);
    const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const secondId = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });

    manager.appendLeafControl({
      targetId: firstId,
      appendParentId: secondId,
      appendMode: "side",
    });
    await expect(loadTranscriptEvents(scope)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "leaf",
          targetId: firstId,
          appendParentId: secondId,
          appendMode: "side",
        }),
      ]),
    );

    const reopened = SessionManager.open(scope, dir);
    expect(reopened.getLeafId()).toBe(firstId);
    expect(reopened.getAppendParentId()).toBe(secondId);
    expect(reopened.getAppendMode()).toBe("side");
  });

  it("uses the selected logical leaf immediately after a side append control", () => {
    const manager = SessionManager.inMemory("/tmp");
    const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const secondId = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
    const control = manager.appendLeafControl({
      targetId: firstId,
      appendParentId: secondId,
      appendMode: "side",
    });

    const thirdId = manager.appendMessage({ role: "user", content: "third", timestamp: 3 });

    expect(manager.getBranch().map((entry) => entry.id)).toEqual([firstId, thirdId]);
    manager.branch(control.id);
    expect(manager.getLeafId()).toBe(firstId);
    expect(() =>
      manager.appendLeafControl({
        targetId: thirdId,
        appendParentId: "missing-parent",
      }),
    ).toThrow("Append parent missing-parent not found");
  });

  it("refreshes cwd when switching persisted targets and rejects identity reset", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const firstTarget = {
      agentId: "main",
      sessionId: "first-target",
      sessionKey: "agent:main:first-target",
      storePath,
    };
    const secondTarget = {
      agentId: "main",
      sessionId: "second-target",
      sessionKey: "agent:main:second-target",
      storePath,
    };
    await upsertSessionEntry(firstTarget, { sessionId: firstTarget.sessionId, updatedAt: 1 });
    await upsertSessionEntry(secondTarget, { sessionId: secondTarget.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(firstTarget, {
      cwd: path.join(dir, "first-workspace"),
      message: { role: "user", content: "first" },
    });
    await appendTranscriptMessage(secondTarget, {
      cwd: path.join(dir, "second-workspace"),
      message: { role: "user", content: "second" },
    });

    const manager = SessionManager.open(firstTarget);
    manager.setSessionTarget(secondTarget);

    expect(manager.getCwd()).toBe(path.join(dir, "second-workspace"));
    expect(() => manager.newSession()).toThrow(
      "Persisted session managers cannot change session identity in place",
    );
  });

  it("migrates version-two hook messages before current-role validation", () => {
    const manager = SessionManager.fromEntries([
      {
        type: "session",
        version: 2,
        id: "legacy-hook-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp",
      },
      {
        type: "message",
        id: "legacy-hook-message",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "hookMessage",
          customType: "hook",
          content: "legacy hook context",
        },
      },
    ]);

    expect(manager.getEntry("legacy-hook-message")).toMatchObject({
      message: { role: "custom", content: "legacy hook context" },
    });
  });

  it("keeps stale appenders valid across a reset while snapshot replacement rotates generation", async () => {
    const dir = await makeTempDir();
    const scope = {
      agentId: "main",
      sessionId: "sqlite-reset-stale-appender",
      sessionKey: "agent:main:dashboard:sqlite-reset-stale-appender",
      storePath: path.join(dir, "sessions.json"),
    };
    const marker = formatSqliteSessionFileMarker(scope);
    await upsertSessionEntry(scope, {
      sessionFile: marker,
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(scope, {
      eventId: "initial-user",
      message: { role: "user", content: "before reset" },
      parentId: null,
    });
    const cursor = readTranscriptRawDelta(scope);
    expect(cursor.kind).toBe("page");
    if (cursor.kind !== "page") {
      throw new Error("expected initial raw cursor page");
    }

    const staleManager = openMarker(marker, scope.sessionKey, dir);
    const resetManager = openMarker(marker, scope.sessionKey, dir);
    resetManager.appendResetBoundary("reset");
    expect(() =>
      staleManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "late append" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    ).not.toThrow();

    const resumed = readTranscriptRawDelta(scope, { cursor: cursor.cursor });
    expect(resumed.kind).toBe("page");
    const events = await loadTranscriptEvents(scope);
    expect(events.map((event) => (event as { type?: unknown }).type)).toContain("reset");
    const context = JSON.stringify(openMarker(marker, scope.sessionKey, dir).buildSessionContext());
    expect(context).not.toContain("before reset");
    expect(context).toContain("late append");

    expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
    expect(readTranscriptRawDelta(scope, { cursor: cursor.cursor })).toMatchObject({
      kind: "reset",
      reason: "generation_mismatch",
    });
  });

  it("persists a deduped runtime user entry before its SQLite descendants", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-runtime-user-parent";
    const sessionKey = "agent:main:dashboard:sqlite-runtime-user-parent";
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    const marker = formatSqliteSessionFileMarker(scope);
    const userMessage = {
      role: "user" as const,
      content: "question",
      idempotencyKey: "runtime-user-parent:user",
      timestamp: 1,
    };
    await upsertSessionEntry(scope, { sessionFile: marker, sessionId, updatedAt: 1 });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "pre-persisted-user",
      message: userMessage,
      now: 1,
    });
    const bootstrap = readTranscriptRawDelta(scope, { maxBytes: 10_000, maxEvents: 100 });
    expect(bootstrap.kind).toBe("page");
    if (bootstrap.kind !== "page") {
      throw new Error(`expected bootstrap page, got ${bootstrap.kind}`);
    }

    const sessionManager = openMarker(marker, sessionKey, dir);
    const runtimeUserId = sessionManager.appendMessage(userMessage);
    const assistantId = sessionManager.appendMessage(buildAssistantMessage("answer"));
    const resumed = readTranscriptRawDelta(scope, {
      cursor: bootstrap.cursor,
      maxBytes: 10_000,
      maxEvents: 100,
    });

    expect(resumed.kind).toBe("page");
    if (resumed.kind !== "page") {
      throw new Error(`expected append page, got ${resumed.kind}`);
    }
    expect(resumed.events.map((row) => (row.event as { id?: string }).id)).toEqual([
      runtimeUserId,
      assistantId,
    ]);
    const assistantEvent = resumed.events.at(1)?.event as { parentId?: string } | undefined;
    expect(assistantEvent?.parentId).toBe(runtimeUserId);
  });

  it("preserves root-to-leaf ordering across session branches", () => {
    const entries = [
      {
        type: "message",
        id: "root",
        parentId: null,
        timestamp: "2026-07-16T00:00:00.000Z",
        message: { role: "user", content: "root", timestamp: 1 },
      },
      {
        type: "message",
        id: "main-leaf",
        parentId: "root",
        timestamp: "2026-07-16T00:00:01.000Z",
        message: { role: "user", content: "main", timestamp: 2 },
      },
      {
        type: "message",
        id: "side-middle",
        parentId: "root",
        timestamp: "2026-07-16T00:00:02.000Z",
        message: { role: "user", content: "side middle", timestamp: 3 },
      },
      {
        type: "message",
        id: "side-leaf",
        parentId: "side-middle",
        timestamp: "2026-07-16T00:00:03.000Z",
        message: { role: "user", content: "side leaf", timestamp: 4 },
      },
    ] satisfies SessionMessageEntry[];
    const manager = SessionManager.inMemory();
    for (const entry of entries) {
      manager.appendMessage(entry.message);
      if (entry.id === "main-leaf") {
        manager.branch(manager.getBranch().at(0)!.id);
      }
    }

    expect(buildSessionContext(entries, "side-leaf").messages).toMatchObject([
      { content: "root" },
      { content: "side middle" },
      { content: "side leaf" },
    ]);
    expect(
      manager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message),
    ).toMatchObject([{ content: "root" }, { content: "side middle" }, { content: "side leaf" }]);
  });

  it("normalizes session names to one line", () => {
    const manager = SessionManager.inMemory();

    manager.appendSessionInfo("  first\nsecond\r\nthird  ");

    expect(manager.getSessionName()).toBe("first second third");
  });

  it("ignores opaque SQLite rows while resolving the session cwd", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-opaque-header";
    const sessionKey = "agent:main:dashboard:sqlite-opaque-header";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionFile: marker, sessionId, updatedAt: 10 },
    );

    const loaded = SessionManager.fromEntries([
      null,
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: sessionId,
        timestamp: "2026-07-14T00:00:00.000Z",
        cwd: dir,
      },
    ]);

    expect(loaded.getCwd()).toBe(dir);
  });

  it("persists prompt-released leaf controls through SQLite markers", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-prompt-release";
    const sessionKey = "agent:main:dashboard:sqlite-prompt-release";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question" },
    });
    const assistant = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "base-answer",
      message: buildAssistantMessage("base answer"),
      parentId: user.messageId,
    });
    const sessionManager = openMarker(marker, sessionKey, dir);
    const sideEntry = {
      type: "message" as const,
      id: "side-delivery",
      parentId: assistant.messageId,
      timestamp: "2026-06-15T00:00:03.000Z",
      message: buildAssistantMessage("side delivery"),
    };
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: sideEntry.id,
      message: sideEntry.message,
      parentId: sideEntry.parentId,
    });

    const mergeResult = sessionManager.mergePromptReleasedSessionEntries([sideEntry], {
      persistLeaf: true,
    });

    expect(mergeResult?.publishedEntries).toEqual([{ kind: "id", id: expect.any(String) }]);
    const records = await loadTranscriptEvents(scope);
    expect(records.at(-1)).toMatchObject({
      type: "leaf",
      parentId: sideEntry.id,
      targetId: assistant.messageId,
      appendParentId: sideEntry.id,
      appendMode: "side",
    });
    await expect(fs.stat(path.join(process.cwd(), marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reloads SQLite markers through setSessionFile without switching to file paths", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "legacy-sqlite-marker-reload";
    const sessionKey = "agent:main:dashboard:legacy-sqlite-marker-reload";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question before reload" },
    });

    const sessionManager = openMarker(marker, sessionKey, dir);
    sessionManager.setSessionTarget(scope);
    expect(sessionManager.buildSessionContext().messages).toEqual([
      expect.objectContaining({ content: "question before reload", role: "user" }),
    ]);
    sessionManager.appendMessage(buildAssistantMessage("answer after reload"));

    await expect(fs.stat(path.join(process.cwd(), marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({
        message: expect.objectContaining({ content: "question before reload", role: "user" }),
        type: "message",
      }),
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: "answer after reload" }],
          role: "assistant",
        }),
        type: "message",
      }),
    ]);
  });

  it("creates SQLite-backed branch sessions without rewriting the source transcript", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-branch-source";
    const sessionKey = "agent:main:dashboard:sqlite-branch-source";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntry(
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
    const branchedMarker = sessionManager.createBranchedSession(assistant.messageId);
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
  });

  it("persists user turns when a SQLite marker has no external recorder", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-direct-user-session";
    const sessionKey = "agent:main:voice:direct-user";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );

    const sessionManager = openMarker(marker, sessionKey, dir);
    const userId = sessionManager.appendMessage({
      role: "user",
      content: "voice prompt",
      timestamp: Date.now(),
    });

    await expect(
      loadTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: userId,
        message: expect.objectContaining({ content: "voice prompt", role: "user" }),
        type: "message",
      }),
    );
  });

  it("rewrites SQLite transcript rows when removing trailing entries", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-remove-trailing-session";
    const sessionKey = "agent:main:dashboard:sqlite-remove-trailing";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question" },
    });
    const baseAnswer = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "base-answer",
      message: buildAssistantMessage("base answer"),
      parentId: user.messageId,
    });
    const temporaryError = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "temporary-error",
      message: buildAssistantMessage("temporary error"),
      parentId: baseAnswer.messageId,
    });

    const sessionManager = openMarker(marker, sessionKey, dir);

    expect(
      sessionManager.removeTrailingEntries((entry) => entry.id === temporaryError.messageId),
    ).toBe(1);
    expect(sessionManager.getLeafId()).toBe(baseAnswer.messageId);
    const replacementId = sessionManager.appendMessage(buildAssistantMessage("replacement answer"));

    const records = await loadTranscriptEvents(scope);
    expect(
      records.map((record) =>
        record && typeof record === "object" && "id" in record ? record.id : undefined,
      ),
    ).not.toContain(temporaryError.messageId);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: replacementId,
          message: expect.objectContaining({
            content: [{ type: "text", text: "replacement answer" }],
            role: "assistant",
          }),
          parentId: baseAnswer.messageId,
          type: "message",
        }),
      ]),
    );
    await expect(fs.stat(path.join(process.cwd(), marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("SessionManager.openFile test compatibility", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("separates appended records from a final unterminated JSONL record", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "unterminated.jsonl");
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "unterminated",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir,
      }),
    );

    SessionManager.openFile(sessionFile, dir).appendMessage({
      role: "user",
      content: "appended",
      timestamp: 1,
    });

    expect(SessionManager.openFile(sessionFile, dir).buildSessionContext().messages).toEqual([
      expect.objectContaining({ content: "appended", role: "user" }),
    ]);
  });
});
describe("parseSessionEntries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses valid JSONL lines without logging warnings", () => {
    const warnSpy = vi.spyOn(Logger, "logWarn").mockImplementation(() => {});
    const content = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", id: "m1" }),
    ].join("\n");

    const entries = parseSessionEntries(content);

    expect(entries).toHaveLength(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs a warning and skips malformed JSONL lines while preserving valid entries", () => {
    const warnSpy = vi.spyOn(Logger, "logWarn").mockImplementation(() => {});
    const content = [
      JSON.stringify({ type: "session", id: "s1" }),
      "not valid json {{{",
      JSON.stringify({ type: "message", id: "m1" }),
    ].join("\n");

    const entries = parseSessionEntries(content);

    expect(entries).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("parseJsonlEntries: skipped 1 malformed JSONL line"),
    );
  });

  it("reports the correct skip count for multiple malformed lines", () => {
    const warnSpy = vi.spyOn(Logger, "logWarn").mockImplementation(() => {});
    const content = [
      "bad line 1",
      JSON.stringify({ type: "session", id: "s1" }),
      "bad line 2",
      "bad line 3",
    ].join("\n");

    const entries = parseSessionEntries(content);

    expect(entries).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("parseJsonlEntries: skipped 3 malformed JSONL line"),
    );
  });

  it("skips empty lines without counting them as malformed", () => {
    const warnSpy = vi.spyOn(Logger, "logWarn").mockImplementation(() => {});
    const content = [
      "",
      JSON.stringify({ type: "session", id: "s1" }),
      "",
      JSON.stringify({ type: "message", id: "m1" }),
      "",
    ].join("\n");

    const entries = parseSessionEntries(content);

    expect(entries).toHaveLength(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("parseJsonlEntries logs warning for malformed lines via loadEntriesFromFile", async () => {
    const warnSpy = vi.spyOn(Logger, "logWarn").mockImplementation(() => {});
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const header = buildSessionHeader(dir);
    const content = [
      JSON.stringify(header),
      "not valid json {{{",
      JSON.stringify(buildMessageEntry(1, null)),
    ].join("\n");
    await fs.writeFile(sessionFile, content, "utf8");

    const entries = parseSessionEntries(await fs.readFile(sessionFile, "utf8"));

    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((call) =>
        call[0].includes("parseJsonlEntries: skipped 1 malformed JSONL line"),
      ),
    ).toBe(true);
  });
});

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

function buildSessionHeader(cwd: string, id = "test-session") {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp: "2026-06-04T00:00:00.000Z",
    cwd,
  };
}

function buildMessageEntry(index: number, parentId: string | null): SessionEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId,
    timestamp: `2026-06-04T00:00:0${index}.000Z`,
    message: { role: "user", content: `message ${index}`, timestamp: index },
  };
}
