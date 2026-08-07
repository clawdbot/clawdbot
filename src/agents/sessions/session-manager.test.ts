// Session manager tests cover SQLite persistence and in-memory tree behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import {
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  SessionManager,
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

  it("rejects persisted legacy transcripts until doctor or import migrates them", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "legacy-persisted-session";
    const sessionKey = "agent:main:legacy-persisted-session";
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntry(scope, { sessionId, updatedAt: 1 });
    replaceTranscriptEventsSync(scope, [
      {
        type: "session",
        version: 1,
        id: sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir,
      },
      {
        type: "message",
        message: { role: "user", content: "legacy message" },
      },
    ]);

    expect(() => SessionManager.open(scope, dir)).toThrow(
      "require doctor/import migration before runtime use",
    );
    const existingManager = SessionManager.inMemory("/original-workspace");
    expect(() => existingManager.setSessionTarget(scope)).toThrow(
      "require doctor/import migration before runtime use",
    );
    expect(existingManager.getCwd()).toBe("/original-workspace");

    const currentScope = {
      agentId: "main",
      sessionId: "current-persisted-session",
      sessionKey: "agent:main:current-persisted-session",
      storePath,
    };
    await upsertSessionEntry(currentScope, { sessionId: currentScope.sessionId, updatedAt: 2 });
    const currentManager = SessionManager.open(currentScope, dir);
    expect(() => currentManager.setSessionTarget(scope)).toThrow(
      "require doctor/import migration before runtime use",
    );
    currentManager.appendModelChange("test-provider", "test-model");
    await expect(loadTranscriptEvents(currentScope)).resolves.toEqual([
      expect.objectContaining({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: currentScope.sessionId,
      }),
      expect.objectContaining({ type: "model_change" }),
    ]);
  });

  it("skips malformed null rows while opening a persisted transcript", async () => {
    const dir = await makeTempDir();
    const scope = {
      agentId: "main",
      sessionId: "sqlite-malformed-row",
      sessionKey: "agent:main:dashboard:sqlite-malformed-row",
      storePath: path.join(dir, "sessions.json"),
    };
    replaceTranscriptEventsSync(scope, [
      null,
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: scope.sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir,
      },
    ] as never);

    const manager = SessionManager.open(scope, dir);
    expect(manager.getSessionId()).toBe(scope.sessionId);
    expect(manager.getHeader()?.cwd).toBe(dir);
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

  it("persists the current header before a first non-message entry", async () => {
    const dir = await makeTempDir();
    const scope = {
      agentId: "main",
      sessionId: "sqlite-model-change-first",
      sessionKey: "agent:main:dashboard:sqlite-model-change-first",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
    });

    const manager = SessionManager.open(scope, dir);
    manager.appendModelChange("test-provider", "test-model");

    await expect(loadTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: scope.sessionId,
        cwd: dir,
      }),
      expect.objectContaining({
        type: "model_change",
        provider: "test-provider",
        modelId: "test-model",
      }),
    ]);
    expect(() => SessionManager.open(scope, dir)).not.toThrow();
  });

  it("persists a fresh SQLite session header and first message", async () => {
    const dir = await makeTempDir();
    const scope = {
      agentId: "main",
      sessionId: "sqlite-fresh-session",
      sessionKey: "agent:main:sqlite-fresh-session",
      storePath: path.join(dir, "sessions.json"),
    };

    expect(loadSessionEntry(scope)).toBeUndefined();
    const manager = SessionManager.open(scope, dir);
    expect(loadSessionEntry(scope)).toBeUndefined();
    const messageId = manager.appendMessage({
      role: "user",
      content: "first message",
      timestamp: 1,
    });

    await expect(loadTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({
        id: scope.sessionId,
        type: "session",
        version: CURRENT_SESSION_VERSION,
      }),
      expect.objectContaining({
        id: messageId,
        message: expect.objectContaining({ content: "first message", role: "user" }),
        type: "message",
      }),
    ]);
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId: scope.sessionId });
  });

  it("does not rewrite an existing session row when opening an empty transcript", async () => {
    const dir = await makeTempDir();
    const scope = {
      agentId: "main",
      sessionId: "sqlite-empty-existing-row-target",
      sessionKey: "agent:main:sqlite-empty-existing-row",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntry(scope, {
      sessionId: "sqlite-existing-row",
      updatedAt: 123,
      label: "preserved",
    });
    const before = loadSessionEntry(scope);

    SessionManager.open(scope, dir);

    expect(loadSessionEntry(scope)).toEqual(before);
  });

  it("does not overwrite a rebound session row when the first append seeds its header", async () => {
    const dir = await makeTempDir();
    const scope = {
      agentId: "main",
      sessionId: "sqlite-stale-appender",
      sessionKey: "agent:main:sqlite-rebound-before-header",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntry(scope, {
      sessionId: "sqlite-current-owner",
      updatedAt: 456,
      label: "preserved",
    });
    const before = loadSessionEntry(scope);
    const manager = SessionManager.open(scope, dir);

    expect(() =>
      manager.appendMessage({ role: "user", content: "stale message", timestamp: 1 }),
    ).toThrow("Session transcript header was not persisted");
    expect(loadSessionEntry(scope)).toEqual(before);
  });

  it("rejects invalid entries before mutating in-memory state", () => {
    const manager = SessionManager.inMemory("/tmp");
    const entriesBefore = manager.getEntries();

    expect(() => manager.appendModelChange("", "")).toThrow("Invalid session transcript entry");
    expect(manager.getEntries()).toEqual(entriesBefore);
    expect(manager.getLeafId()).toBeNull();
    expect(manager.getAppendParentId()).toBeNull();
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

  it("reloads prompt-time SQLite appends before the attempt resumes", async () => {
    const dir = await makeTempDir();
    const target = {
      agentId: "main",
      sessionId: "prompt-reload",
      sessionKey: "agent:main:prompt-reload",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(target, dir);
    const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const external = await appendTranscriptMessage(target, {
      message: { role: "user", content: "prompt-time", timestamp: 2 },
      now: 2,
      parentId: firstId,
    });

    expect(manager.getLeafId()).toBe(firstId);
    manager.reloadPersistedTranscript();

    expect(manager.getLeafId()).toBe(external.messageId);
  });

  it("clears side-append mode when switching to a header-only target", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const firstTarget = {
      agentId: "main",
      sessionId: "side-target",
      sessionKey: "agent:main:side-target",
      storePath,
    };
    const secondTarget = {
      agentId: "main",
      sessionId: "header-target",
      sessionKey: "agent:main:header-target",
      storePath,
    };
    await upsertSessionEntry(firstTarget, { sessionId: firstTarget.sessionId, updatedAt: 1 });
    await upsertSessionEntry(secondTarget, { sessionId: secondTarget.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(firstTarget, dir);
    const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    manager.appendLeafControl({ targetId: firstId, appendParentId: firstId, appendMode: "side" });
    replaceTranscriptEventsSync(secondTarget, [
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: secondTarget.sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir,
      },
    ]);

    manager.setSessionTarget(secondTarget);

    expect(manager.getAppendMode()).toBeUndefined();
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
          content: "legacy hook context",
        },
      },
    ]);

    expect(manager.getEntry("legacy-hook-message")).toMatchObject({
      message: { role: "custom", customType: "hook", content: "legacy hook context" },
    });
  });

  it("does not mutate frozen caller entries during in-memory migration", () => {
    const entries = [
      Object.freeze({
        type: "session" as const,
        version: 2,
        id: "frozen-legacy-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp",
      }),
      Object.freeze({
        type: "message" as const,
        id: "frozen-legacy-hook",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: Object.freeze({ role: "hookMessage", content: "frozen hook context" }),
      }),
    ] as const;

    const manager = SessionManager.fromEntries(Object.freeze(entries));

    expect(manager.getEntry("frozen-legacy-hook")).toMatchObject({
      message: { role: "custom", customType: "hook", content: "frozen hook context" },
    });
    expect(entries[1].message).toEqual({
      role: "hookMessage",
      content: "frozen hook context",
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

  it("reuses a pre-persisted user as the canonical SQLite parent", async () => {
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
    expect(runtimeUserId).toBe("pre-persisted-user");
    expect(resumed.events.map((row) => (row.event as { id?: string }).id)).toEqual([assistantId]);
    expect(resumed.events[0]?.event).toMatchObject({ parentId: "pre-persisted-user" });
    expect(
      (await loadTranscriptEvents(scope)).filter(
        (event) =>
          (event as { message?: { role?: string; idempotencyKey?: string } }).message?.role ===
            "user" &&
          (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
            userMessage.idempotencyKey,
      ),
    ).toHaveLength(1);
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
    expect(sessionManager.getAppendParentId()).toBe(sideEntry.id);
    expect(sessionManager.getAppendMode()).toBe("side");
    const reopened = openMarker(marker, sessionKey, dir);
    expect(reopened.getAppendParentId()).toBe(sideEntry.id);
    expect(reopened.getAppendMode()).toBe("side");
    await expect(fs.stat(path.join(process.cwd(), marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a prompt-released leaf control after the session target rebounds", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-prompt-release-rebound";
    const sessionKey = "agent:main:dashboard:sqlite-prompt-release-rebound";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntry(scope, { sessionFile: marker, sessionId, updatedAt: 10 });
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "rebound-user",
      message: { role: "user", content: "question", timestamp: 1 },
    });
    const assistant = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "rebound-assistant",
      message: buildAssistantMessage("answer"),
      parentId: user.messageId,
    });
    const sessionManager = openMarker(marker, sessionKey, dir);
    const sideEntry = {
      type: "message" as const,
      id: "rebound-side-delivery",
      parentId: assistant.messageId,
      timestamp: "2026-07-26T00:00:00.000Z",
      message: buildAssistantMessage("side delivery"),
    };
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: sideEntry.id,
      message: sideEntry.message,
      parentId: sideEntry.parentId,
    });
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "replacement-session", updatedAt: 20 },
    );

    try {
      sessionManager.appendCompaction("late summary", assistant.messageId, 42);
      throw new Error("expected rebound compaction persistence to fail");
    } catch (error) {
      expect(error).toMatchObject({
        cause: {
          actualSessionId: "replacement-session",
          code: "session-rebound",
          expectedSessionId: sessionId,
          sessionKey,
        },
      });
    }

    expect(() =>
      sessionManager.mergePromptReleasedSessionEntries([sideEntry], { persistLeaf: true }),
    ).toThrow("leaf control was not persisted");
    const entriesBeforeRejectedAppends = sessionManager.getEntries();
    const leafBeforeRejectedAppends = sessionManager.getLeafId();
    const appendParentBeforeRejectedAppends = sessionManager.getAppendParentId();
    expect(() => sessionManager.branchWithSummary(null, "late summary")).toThrow(
      "entry was not persisted",
    );
    expect(() => sessionManager.appendModelChange("openai", "gpt-5.5")).toThrow(
      "entry was not persisted",
    );
    expect(() =>
      sessionManager.appendMessage({ role: "user", content: "late message", timestamp: 1 }),
    ).toThrow("message was not persisted");
    expect(sessionManager.getEntries()).toEqual(entriesBeforeRejectedAppends);
    expect(sessionManager.getLeafId()).toBe(leafBeforeRejectedAppends);
    expect(sessionManager.getAppendParentId()).toBe(appendParentBeforeRejectedAppends);
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
