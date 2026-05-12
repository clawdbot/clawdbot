import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resetReplyRunSession,
  setAgentRunnerSessionResetTestDeps,
} from "./agent-runner-session-reset.js";
import { createTestFollowupRun, writeTestSessionStore } from "./agent-runner.test-fixtures.js";

const refreshQueuedFollowupSessionMock = vi.fn();
const errorMock = vi.fn();

async function expectPathMissing(targetPath: string): Promise<void> {
  let accessError: NodeJS.ErrnoException | undefined;
  try {
    await fs.access(targetPath);
  } catch (error) {
    accessError = error as NodeJS.ErrnoException;
  }
  expect(accessError?.code).toBe("ENOENT");
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

  it("rotates the session and clears stale runtime and fallback fields", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      sessionFile: path.join(rootDir, "session.jsonl"),
      modelProvider: "qwencode",
      model: "qwen",
      contextTokens: 123,
      fallbackNoticeSelectedModel: "anthropic/claude",
      fallbackNoticeActiveModel: "openai/gpt",
      fallbackNoticeReason: "rate limit",
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
    expect(activeSessionEntry?.sessionId).toBe("00000000-0000-0000-0000-000000000123");
    expect(followupRun.run.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(activeSessionEntry?.modelProvider).toBeUndefined();
    expect(activeSessionEntry?.model).toBeUndefined();
    expect(activeSessionEntry?.contextTokens).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeSelectedModel).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeActiveModel).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeReason).toBeUndefined();
    expect(activeSessionEntry?.systemPromptReport).toBeUndefined();
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: "main",
      previousSessionId: "session",
      nextSessionId: activeSessionEntry?.sessionId,
      nextSessionFile: activeSessionEntry?.sessionFile,
    });
    expect(errorMock).toHaveBeenCalledWith("reset 00000000-0000-0000-0000-000000000123");

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      main: SessionEntry;
    };
    expect(persisted.main.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(persisted.main.fallbackNoticeReason).toBeUndefined();
  });

  it("cleans up the old transcript when requested", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const oldTranscriptPath = path.join(rootDir, "old-session.jsonl");
    await fs.writeFile(oldTranscriptPath, "old", "utf8");
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

    await expectPathMissing(oldTranscriptPath);
  });
});
