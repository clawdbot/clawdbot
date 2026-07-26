// Tests agent runner session reset cleanup and restart behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import { resetReplyRunSession } from "./agent-runner-session-reset.js";
import { setAgentRunnerSessionResetTestDeps } from "./agent-runner-session-reset.test-support.js";
import { createTestFollowupRun, writeTestSessionStore } from "./agent-runner.test-fixtures.js";

const refreshQueuedFollowupSessionMock = vi.fn();
const errorMock = vi.fn();

async function writeFileTranscript(filePath: string, sessionId: string): Promise<void> {
  await fs.writeFile(
    filePath,
    [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: "/",
      },
      {
        type: "message",
        id: "user-before-reset",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: { role: "user", content: "before reset" },
      },
      {
        type: "message",
        id: "assistant-before-reset",
        parentId: "user-before-reset",
        timestamp: new Date(2).toISOString(),
        message: { role: "assistant", content: "answer" },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8",
  );
}

describe("resetReplyRunSession", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reset-run-"));
    refreshQueuedFollowupSessionMock.mockReset();
    errorMock.mockReset();
    setAgentRunnerSessionResetTestDeps({
      generateSecureUuid: () => "00000000-0000-0000-0000-000000000123",
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
      error: errorMock,
    });
  });

  afterEach(async () => {
    setAgentRunnerSessionResetTestDeps();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("appends a boundary and clears stale runtime and fallback fields", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      sessionFile: path.join(rootDir, "session.jsonl"),
      agentHarnessId: "codex",
      claudeCliSessionId: "native-before-boundary",
      modelProvider: "qwencode",
      model: "qwen",
      contextTokens: 123,
      contextBudgetStatus: {
        schemaVersion: 1,
        source: "pre-prompt-estimate",
        updatedAt: 1,
        provider: "qwencode",
        model: "qwen",
        route: "compact_then_truncate",
        shouldCompact: true,
        estimatedPromptTokens: 120_000,
        contextTokenBudget: 80_000,
        promptBudgetBeforeReserve: 70_000,
        reserveTokens: 10_000,
        effectiveReserveTokens: 10_000,
        remainingPromptBudgetTokens: 0,
        overflowTokens: 50_000,
        toolResultReducibleChars: 0,
        messageCount: 10,
        unwindowedMessageCount: 10,
        sessionId: "session",
      },
      fallbackNoticeSelectedModel: "anthropic/claude",
      fallbackNoticeActiveModel: "openai/gpt",
      fallbackNoticeReason: "rate limit",
      compactionCount: 4,
      memoryFlushAt: 50,
      memoryFlushCompactionCount: 3,
      memoryFlushContextHash: "context-hash",
      memoryFlushFailureCount: 2,
      memoryFlushLastFailedAt: 60,
      memoryFlushLastFailureError: "memory failed",
      systemPromptReport: {
        source: "run",
        generatedAt: 1,
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    };
    const sessionStore = { main: sessionEntry };
    const followupRun = createTestFollowupRun();
    await writeFileTranscript(sessionEntry.sessionFile!, sessionEntry.sessionId);
    await writeTestSessionStore(storePath, "main", sessionEntry);

    let activeSessionEntry: SessionEntry | undefined = sessionEntry;
    let isNewSession = false;
    const reset = await resetReplyRunSession({
      options: {
        failureLabel: "compaction failure",
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey: "main",
      queueKey: "main",
      activeSessionEntry,
      activeSessionStore: sessionStore,
      storePath,
      followupRun,
      onActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      onNewSession: () => {
        isNewSession = true;
      },
    });

    expect(reset).toBe(true);
    expect(isNewSession).toBe(true);
    expect(activeSessionEntry?.sessionId).toBe("session");
    expect(activeSessionEntry?.lifecycleRevision).toBe("00000000-0000-0000-0000-000000000123");
    expect(followupRun.run.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(activeSessionEntry?.modelProvider).toBeUndefined();
    expect(activeSessionEntry?.agentHarnessId).toBeUndefined();
    expect(activeSessionEntry?.claudeCliSessionId).toBeUndefined();
    expect(activeSessionEntry?.model).toBeUndefined();
    expect(activeSessionEntry?.contextTokens).toBeUndefined();
    expect(activeSessionEntry?.contextBudgetStatus).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeSelectedModel).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeActiveModel).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeReason).toBeUndefined();
    expect(activeSessionEntry?.compactionCount).toBe(0);
    expect(activeSessionEntry?.memoryFlushAt).toBeUndefined();
    expect(activeSessionEntry?.memoryFlushCompactionCount).toBeUndefined();
    expect(activeSessionEntry?.memoryFlushContextHash).toBeUndefined();
    expect(activeSessionEntry?.memoryFlushFailureCount).toBeUndefined();
    expect(activeSessionEntry?.memoryFlushLastFailedAt).toBeUndefined();
    expect(activeSessionEntry?.memoryFlushLastFailureError).toBeUndefined();
    expect(activeSessionEntry?.systemPromptReport).toBeUndefined();
    expect(activeSessionEntry?.compactionCount).toBe(0);
    expect(activeSessionEntry?.memoryFlushAt).toBeUndefined();
    expect(activeSessionEntry?.memoryFlushCompactionCount).toBeUndefined();
    expect(activeSessionEntry?.memoryFlushContextHash).toBeUndefined();
    expect(activeSessionEntry?.memoryFlushFailureCount).toBeUndefined();
    expect(activeSessionEntry?.memoryFlushLastFailedAt).toBeUndefined();
    expect(activeSessionEntry?.memoryFlushLastFailureError).toBeUndefined();
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: "main",
      previousSessionId: "session",
      nextSessionId: activeSessionEntry?.sessionId,
      nextSessionFile: activeSessionEntry?.sessionFile,
    });
    expect(errorMock).toHaveBeenCalledWith("reset session");

    const persisted = loadSessionEntry({ storePath, sessionKey: "main" });
    expect(persisted?.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(persisted?.contextBudgetStatus).toBeUndefined();
    expect(persisted?.fallbackNoticeReason).toBeUndefined();
    expect(persisted?.compactionCount).toBe(0);
    expect(persisted?.memoryFlushAt).toBeUndefined();
    expect(persisted?.memoryFlushFailureCount).toBeUndefined();
    expect(persisted?.memoryFlushLastFailedAt).toBeUndefined();
    expect(persisted?.memoryFlushLastFailureError).toBeUndefined();
  });

  it("rejects automatic recovery rotation for a model-locked session", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      sessionId: "locked-session",
      updatedAt: 1,
      sessionFile: path.join(rootDir, "locked-session.jsonl"),
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    };
    const sessionStore = { main: sessionEntry };
    const followupRun = createTestFollowupRun();
    await writeTestSessionStore(storePath, "main", sessionEntry);

    await expect(
      resetReplyRunSession({
        options: {
          failureLabel: "memory flush exhaustion",
          buildLogMessage: (next) => `reset ${next}`,
        },
        sessionKey: "main",
        queueKey: "main",
        activeSessionEntry: sessionEntry,
        activeSessionStore: sessionStore,
        storePath,
        followupRun,
        onActiveSessionEntry: vi.fn(),
        onNewSession: vi.fn(),
      }),
    ).rejects.toThrow("cannot be reset while model selection is locked");

    expect(sessionStore.main).toEqual(sessionEntry);
    expect(followupRun.run.sessionId).not.toBe("00000000-0000-0000-0000-000000000123");
    expect(refreshQueuedFollowupSessionMock).not.toHaveBeenCalled();
  });

  it("retains the transcript when cleanup was requested by the old rotation path", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const oldTranscriptPath = path.join(rootDir, "old-session.jsonl");
    await writeFileTranscript(oldTranscriptPath, "old-session");
    const sessionEntry: SessionEntry = {
      sessionId: "old-session",
      updatedAt: 1,
      sessionFile: oldTranscriptPath,
    };
    const sessionStore = { main: sessionEntry };
    await writeTestSessionStore(storePath, "main", sessionEntry);

    await resetReplyRunSession({
      options: {
        failureLabel: "role ordering conflict",
        cleanupTranscripts: true,
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey: "main",
      queueKey: "main",
      activeSessionEntry: sessionEntry,
      activeSessionStore: sessionStore,
      storePath,
      followupRun: createTestFollowupRun(),
      onActiveSessionEntry: () => {},
      onNewSession: () => {},
    });

    await fs.access(oldTranscriptPath);
  });

  it("preserves the old transcript and session id when cleanup is disabled", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const oldTranscriptPath = path.join(rootDir, "old-session.jsonl");
    await writeFileTranscript(oldTranscriptPath, "old-session");
    const sessionEntry: SessionEntry = {
      sessionId: "old-session",
      updatedAt: 1,
      sessionFile: oldTranscriptPath,
    };
    const sessionStore = { main: sessionEntry };
    await writeTestSessionStore(storePath, "main", sessionEntry);

    let rotatedSessionId: string | undefined;
    await resetReplyRunSession({
      options: {
        failureLabel: "memory flush exhaustion",
        cleanupTranscripts: false,
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey: "main",
      queueKey: "main",
      activeSessionEntry: sessionEntry,
      activeSessionStore: sessionStore,
      storePath,
      followupRun: createTestFollowupRun(),
      onActiveSessionEntry: (entry) => {
        rotatedSessionId = entry.sessionId;
      },
      onNewSession: () => {},
    });

    // The boundary reset keeps both the logical id and transcript in place.
    expect(rotatedSessionId).toBeDefined();
    expect(rotatedSessionId).toBe("old-session");
    await fs.access(oldTranscriptPath);
  });

  it("uses the same SQLite marker and appends a boundary over the kept DM tail", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const oldSessionId = "old-session";
    const oldSessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: oldSessionId,
      storePath,
    });
    const sessionEntry: SessionEntry = {
      sessionFile: oldSessionFile,
      sessionId: oldSessionId,
      updatedAt: 1,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);
    await appendTranscriptMessage(
      { agentId: "main", sessionId: oldSessionId, sessionKey, storePath },
      {
        message: { role: "user", content: "hello" },
      },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId: oldSessionId, sessionKey, storePath },
      {
        message: { role: "assistant", content: "hi" },
      },
    );

    let activeSessionEntry: SessionEntry | undefined;
    await resetReplyRunSession({
      options: {
        failureLabel: "role ordering conflict",
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey,
      queueKey: sessionKey,
      activeSessionEntry: sessionEntry,
      activeSessionStore: sessionStore,
      storePath,
      followupRun: createTestFollowupRun(),
      onActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      onNewSession: () => {},
    });

    expect(activeSessionEntry?.sessionFile).toBe(
      formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: oldSessionId,
        storePath,
      }),
    );
    const replayed = await loadTranscriptEvents({
      agentId: "main",
      sessionId: oldSessionId,
      sessionKey,
      storePath,
    });
    const replayedMessages = replayed.filter(
      (entry): entry is { message: { content?: unknown }; type: "message" } =>
        Boolean(entry && typeof entry === "object" && "message" in entry),
    );
    expect(replayedMessages).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ content: "hello" }) }),
      expect.objectContaining({ message: expect.objectContaining({ content: "hi" }) }),
    ]);
    expect(
      replayed.findLast((entry) => (entry as { type?: unknown }).type === "reset"),
    ).toMatchObject({ reason: "reset", firstKeptEntryId: expect.any(String) });
  });

  it("migrates an unreadable legacy transcript target to the SQLite reset boundary", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const unreadableReplaySource = path.join(rootDir, "previous-transcript-dir");
    await fs.mkdir(unreadableReplaySource);
    const sessionEntry: SessionEntry = {
      sessionFile: unreadableReplaySource,
      sessionId: "old-session",
      updatedAt: 1,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);

    let activeSessionEntry: SessionEntry | undefined;
    await resetReplyRunSession({
      options: {
        failureLabel: "role ordering conflict",
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey,
      queueKey: sessionKey,
      activeSessionEntry: sessionEntry,
      activeSessionStore: sessionStore,
      storePath,
      followupRun: createTestFollowupRun(),
      onActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      onNewSession: () => {},
    });

    expect(activeSessionEntry?.sessionFile).toBe(
      formatSqliteSessionFileMarker({ agentId: "main", sessionId: "old-session", storePath }),
    );
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: "old-session",
        sessionKey,
        storePath,
      }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: "reset" })]));
  });

  it("replaces a SQLite marker for a different transcript target", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionId = "current-session";
    const staleMarker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: "stale-session",
      storePath,
    });
    const sessionEntry: SessionEntry = {
      sessionFile: staleMarker,
      sessionId,
      updatedAt: 1,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);

    let activeSessionEntry: SessionEntry | undefined;
    await resetReplyRunSession({
      options: {
        failureLabel: "stale marker",
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey,
      queueKey: sessionKey,
      activeSessionEntry: sessionEntry,
      activeSessionStore: sessionStore,
      storePath,
      followupRun: createTestFollowupRun(),
      onActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      onNewSession: () => {},
    });

    expect(activeSessionEntry?.sessionFile).toBe(
      formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath }),
    );
    expect(activeSessionEntry?.sessionFile).not.toBe(staleMarker);
  });
});
