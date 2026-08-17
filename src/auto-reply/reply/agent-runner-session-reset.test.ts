// Tests agent runner session reset cleanup and restart behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../../config/sessions/session-diff-baseline-capture.js";
import { applySessionDiffBaseline, loadCheckoutDiff } from "../../sessions/session-diff.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resetReplyRunSession } from "./agent-runner-session-reset.js";
import { setAgentRunnerSessionResetTestDeps } from "./agent-runner-session-reset.test-support.js";
import { createTestFollowupRun, writeTestSessionStore } from "./agent-runner.test-fixtures.js";

const sessionDiffCapture = vi.hoisted(() => ({
  fail: false,
  onStart: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined,
}));

vi.mock("../../sessions/session-diff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/session-diff.js")>();
  return {
    ...actual,
    captureSessionDiffBaseline: async (
      params: Parameters<typeof actual.captureSessionDiffBaseline>[0],
    ) => {
      sessionDiffCapture.onStart?.();
      await sessionDiffCapture.wait;
      if (sessionDiffCapture.fail) {
        throw new Error("git capture failed");
      }
      return await actual.captureSessionDiffBaseline(params);
    },
  };
});

const refreshQueuedFollowupSessionMock = vi.fn();
const resetRegisteredAgentHarnessSessionsMock = vi.fn();
const errorMock = vi.fn();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function initializeGitWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  git(workspace, "init", "-q", "-b", "main");
  git(workspace, "config", "user.email", "test@openclaw.test");
  git(workspace, "config", "user.name", "Test");
  git(workspace, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(workspace, "tracked.txt"), "initial\n", "utf8");
  git(workspace, "add", ".");
  git(workspace, "commit", "-qm", "initial");
  return await fs.realpath(workspace);
}

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
  const sessionKey = "agent:main:main";
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reset-run-"));
    sessionDiffCapture.fail = false;
    sessionDiffCapture.onStart = undefined;
    sessionDiffCapture.wait = undefined;
    refreshQueuedFollowupSessionMock.mockReset();
    resetRegisteredAgentHarnessSessionsMock.mockReset();
    errorMock.mockReset();
    setAgentRunnerSessionResetTestDeps({
      generateSecureUuid: () => "00000000-0000-0000-0000-000000000123",
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
      resetRegisteredAgentHarnessSessions: resetRegisteredAgentHarnessSessionsMock,
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
      lifecycleRunId: "run-before-reset",
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
      fallbackNotice: {
        kind: "active",
        selectedModel: "anthropic/claude",
        activeModel: "openai/gpt",
        reason: "rate limit",
      },
      compactionCount: 4,
      memoryFlush: { kind: "failed", compactionCount: 3, failureCount: 2 },
      systemPromptReport: {
        source: "run",
        generatedAt: 1,
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    const followupRun = createTestFollowupRun();
    await writeFileTranscript(sessionEntry.sessionFile!, sessionEntry.sessionId);
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);

    let activeSessionEntry: SessionEntry | undefined = sessionEntry;
    let isNewSession = false;
    const reset = await resetReplyRunSession({
      options: {
        failureLabel: "compaction failure",
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey,
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
    expect(activeSessionEntry?.lifecycleRunId).toBeUndefined();
    expect(followupRun.run.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(activeSessionEntry?.modelProvider).toBeUndefined();
    expect(activeSessionEntry?.agentHarnessId).toBeUndefined();
    expect(activeSessionEntry?.claudeCliSessionId).toBeUndefined();
    expect(activeSessionEntry?.model).toBeUndefined();
    expect(activeSessionEntry?.contextTokens).toBeUndefined();
    expect(activeSessionEntry?.contextBudgetStatus).toBeUndefined();
    expect(activeSessionEntry?.fallbackNotice).toBeUndefined();
    expect(activeSessionEntry?.compactionCount).toBe(0);
    expect(activeSessionEntry?.memoryFlush).toBeUndefined();
    expect(activeSessionEntry?.systemPromptReport).toBeUndefined();
    expect(activeSessionEntry?.compactionCount).toBe(0);
    expect(activeSessionEntry?.memoryFlush).toBeUndefined();
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: "main",
      previousSessionId: "session",
      nextSessionId: activeSessionEntry?.sessionId,
      nextSessionFile: sessionKey,
    });
    expect(resetRegisteredAgentHarnessSessionsMock).toHaveBeenCalledWith({
      agentId: followupRun.run.agentId,
      sessionId: "session",
      sessionKey,
      sessionFile: sessionKey,
      reason: "reset",
    });
    expect(errorMock).toHaveBeenCalledWith("reset session");

    const persisted = loadSessionEntry({ storePath, sessionKey });
    expect(persisted?.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(persisted?.contextBudgetStatus).toBeUndefined();
    expect(persisted?.fallbackNotice).toBeUndefined();
    expect(persisted?.compactionCount).toBe(0);
    expect(persisted?.memoryFlush).toBeUndefined();
  });

  it("settles a fresh checkout baseline before returning from a local reset", async () => {
    const workspace = await initializeGitWorkspace(rootDir);
    const storePath = path.join(rootDir, "sessions.json");
    await fs.writeFile(path.join(workspace, "before-reset.txt"), "preexisting\n", "utf8");
    const sessionEntry: SessionEntry = {
      createdVia: "operator",
      lifecycleRevision: "before-reset",
      sessionId: "session",
      updatedAt: 1,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);

    let activeSessionEntry: SessionEntry | undefined = sessionEntry;
    await resetReplyRunSession({
      options: {
        failureLabel: "memory flush exhaustion",
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey,
      queueKey: "main",
      activeSessionEntry,
      activeSessionStore: sessionStore,
      storePath,
      followupRun: createTestFollowupRun({ workspaceDir: workspace }),
      onActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      onNewSession: () => {},
    });

    expect(activeSessionEntry?.sessionDiffBaseline).toMatchObject({
      sessionId: "session",
      root: workspace,
    });
    expect(activeSessionEntry?.sessionDiffBaselineCapture).toBeUndefined();
    await fs.writeFile(path.join(workspace, "after-reset.txt"), "resumed turn\n", "utf8");
    const diff = await loadCheckoutDiff({ cwd: workspace, sessionKey });
    const filtered = await applySessionDiffBaseline({
      baseline: activeSessionEntry?.sessionDiffBaseline,
      diff,
      sessionId: "session",
    });
    expect(filtered.files.map((file) => file.path)).toEqual(["after-reset.txt"]);
  });

  it("continues with the authoritative unavailable marker after capture failure", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      lifecycleRevision: "before-reset",
      sessionId: "session",
      updatedAt: 1,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);
    sessionDiffCapture.fail = true;

    let activeSessionEntry: SessionEntry | undefined = sessionEntry;
    await expect(
      resetReplyRunSession({
        options: {
          failureLabel: "memory flush exhaustion",
          buildLogMessage: (next) => `reset ${next}`,
        },
        sessionKey,
        queueKey: "main",
        activeSessionEntry,
        activeSessionStore: sessionStore,
        storePath,
        followupRun: createTestFollowupRun({ workspaceDir: rootDir }),
        onActiveSessionEntry: (entry) => {
          activeSessionEntry = entry;
        },
        onNewSession: () => {},
      }),
    ).resolves.toBe(true);

    expect(activeSessionEntry?.sessionDiffBaselineCapture).toMatchObject({
      status: "unavailable",
    });
    expect(sessionStore[sessionKey]).toEqual(activeSessionEntry);
    expect(loadSessionEntry({ storePath, sessionKey })).toEqual(activeSessionEntry);
  });

  it("replaces a stale pending cache entry when capture loses its generation", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      lifecycleRevision: "before-reset",
      sessionId: "session",
      updatedAt: 1,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);
    const captureStarted = createDeferredCore();
    const captureRelease = createDeferredCore();
    sessionDiffCapture.onStart = () => captureStarted.resolve();
    sessionDiffCapture.wait = captureRelease.promise;

    const reset = resetReplyRunSession({
      options: {
        failureLabel: "memory flush exhaustion",
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey,
      queueKey: "main",
      activeSessionEntry: sessionEntry,
      activeSessionStore: sessionStore,
      storePath,
      followupRun: createTestFollowupRun({ workspaceDir: rootDir }),
      onActiveSessionEntry: () => {},
      onNewSession: () => {},
    });
    await captureStarted.promise;
    const stalePending = sessionStore[sessionKey];
    expect(stalePending.sessionDiffBaselineCapture).toMatchObject({ status: "pending" });
    const replacement: SessionEntry = {
      ...stalePending,
      lifecycleRevision: "replacement-generation",
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
    };
    await replaceSessionEntry({ storePath, sessionKey }, replacement);
    const authoritativeReplacement = loadSessionEntry({ storePath, sessionKey });
    captureRelease.resolve();

    const rejection = await reset.catch((error: unknown) => error);
    expect(isSessionWorkStartInvalidatedError(rejection)).toBe(true);
    expect(sessionStore[sessionKey]).toEqual(authoritativeReplacement);
    expect(sessionStore[sessionKey]).toEqual(loadSessionEntry({ storePath, sessionKey }));
    expect(sessionStore[sessionKey]).not.toBe(stalePending);
  });

  it("does not arm a local checkout claim for an exec-node reset", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      execNode: "worker-1",
      lifecycleRevision: "before-reset",
      sessionId: "session",
      updatedAt: 1,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);

    await resetReplyRunSession({
      options: {
        failureLabel: "memory flush exhaustion",
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey,
      queueKey: "main",
      activeSessionEntry: sessionEntry,
      activeSessionStore: sessionStore,
      storePath,
      followupRun: createTestFollowupRun({ workspaceDir: rootDir }),
      onActiveSessionEntry: () => {},
      onNewSession: () => {},
    });

    expect(loadSessionEntry({ storePath, sessionKey })).not.toHaveProperty(
      "sessionDiffBaselineCapture",
    );
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
    const sessionStore = { [sessionKey]: sessionEntry };
    const followupRun = createTestFollowupRun();
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);

    await expect(
      resetReplyRunSession({
        options: {
          failureLabel: "memory flush exhaustion",
          buildLogMessage: (next) => `reset ${next}`,
        },
        sessionKey,
        queueKey: "main",
        activeSessionEntry: sessionEntry,
        activeSessionStore: sessionStore,
        storePath,
        followupRun,
        onActiveSessionEntry: vi.fn(),
        onNewSession: vi.fn(),
      }),
    ).rejects.toThrow("cannot be reset while model selection is locked");

    expect(sessionStore[sessionKey]).toEqual(sessionEntry);
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
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);

    await resetReplyRunSession({
      options: {
        failureLabel: "role ordering conflict",
        cleanupTranscripts: true,
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey,
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
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);

    let rotatedSessionId: string | undefined;
    await resetReplyRunSession({
      options: {
        failureLabel: "memory flush exhaustion",
        cleanupTranscripts: false,
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey,
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

    expect(activeSessionEntry).not.toHaveProperty("sessionFile");
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

    expect(activeSessionEntry).not.toHaveProperty("sessionFile");
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

    expect(activeSessionEntry).not.toHaveProperty("sessionFile");
  });
});
