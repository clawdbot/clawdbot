import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { FailoverError } from "../failover-error.js";
import type { EmbeddedPiRunResult } from "../pi-embedded.js";
import { persistCliTurnTranscript, runAgentAttempt } from "./attempt-execution.js";

const runCliAgentMock = vi.hoisted(() => vi.fn());
const ORIGINAL_HOME = process.env.HOME;

vi.mock("../cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string) => provider.trim().toLowerCase() === "claude-cli",
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(),
}));

function makeCliResult(text: string): EmbeddedPiRunResult {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId: "session-cli",
        provider: "claude-cli",
        model: "opus",
        usage: {
          input: 12,
          output: 4,
          cacheRead: 3,
          cacheWrite: 0,
          total: 19,
        },
      },
      executionTrace: {
        winnerProvider: "claude-cli",
        winnerModel: "opus",
        fallbackUsed: false,
        runner: "cli",
      },
    },
  };
}

async function readSessionMessages(sessionFile: string) {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: unknown })
    .filter((entry) => entry.type === "message")
    .map(
      (entry) =>
        entry.message as { role?: string; content?: unknown; provider?: string; model?: string },
    );
}

describe("CLI attempt execution", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-attempt-"));
    storePath = path.join(tmpDir, "sessions.json");
    runCliAgentMock.mockReset();
  });

  afterEach(async () => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("clears stale Claude CLI session IDs before retrying after session expiration", async () => {
    const sessionKey = "agent:main:subagent:cli-expired";
    const homeDir = path.join(tmpDir, "home");
    const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
    process.env.HOME = homeDir;
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, "stale-cli-session.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      })}\n`,
      "utf-8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-123",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "stale-cli-session" },
      claudeCliSessionId: "stale-legacy-session",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    runCliAgentMock
      .mockRejectedValueOnce(
        new FailoverError("session expired", {
          reason: "session_expired",
          provider: "claude-cli",
          model: "opus",
          status: 410,
        }),
      )
      .mockResolvedValueOnce(makeCliResult("hello from cli"));

    await runAgentAttempt({
      providerOverride: "claude-cli",
      modelOverride: "opus",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "retry this",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cli-expired",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(2);
    expect(runCliAgentMock.mock.calls[0]?.[0]?.cliSessionId).toBe("stale-cli-session");
    expect(runCliAgentMock.mock.calls[1]?.[0]?.cliSessionId).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBeUndefined();

    const persisted = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(persisted[sessionKey]?.claudeCliSessionId).toBeUndefined();
  });

  it("does not pass --resume when the stored Claude CLI transcript is missing", async () => {
    const sessionKey = "agent:main:direct:claude-missing-transcript";
    const homeDir = path.join(tmpDir, "home");
    process.env.HOME = homeDir;
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-123",
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "phantom-claude-session",
          authProfileId: "anthropic:claude-cli",
        },
      },
      cliSessionIds: { "claude-cli": "phantom-claude-session" },
      claudeCliSessionId: "phantom-claude-session",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("fresh cli response"));

    await runAgentAttempt({
      providerOverride: "claude-cli",
      modelOverride: "opus",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "remember me",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cli-missing-transcript",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runCliAgentMock.mock.calls[0]?.[0]?.cliSessionId).toBeUndefined();
    expect(runCliAgentMock.mock.calls[0]?.[0]?.cliSessionBinding).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBeUndefined();

    const persisted = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(persisted[sessionKey]?.claudeCliSessionId).toBeUndefined();
  });

  it("keeps Claude CLI resume when the stored transcript has assistant content", async () => {
    const sessionKey = "agent:main:direct:claude-transcript-present";
    const cliSessionId = "existing-claude-session";
    const homeDir = path.join(tmpDir, "home");
    const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
    process.env.HOME = homeDir;
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, `${cliSessionId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "previous reply" }],
        },
      })}\n`,
      "utf-8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-456",
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: cliSessionId,
          authProfileId: "anthropic:claude-cli",
        },
      },
      cliSessionIds: { "claude-cli": cliSessionId },
      claudeCliSessionId: cliSessionId,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("resumed cli response"));

    await runAgentAttempt({
      providerOverride: "claude-cli",
      modelOverride: "opus",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cli-transcript-present",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runCliAgentMock.mock.calls[0]?.[0]?.cliSessionId).toBe(cliSessionId);
    expect(runCliAgentMock.mock.calls[0]?.[0]?.cliSessionBinding).toEqual({
      sessionId: cliSessionId,
      authProfileId: "anthropic:claude-cli",
    });
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe(cliSessionId);
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBe(cliSessionId);
  });

  it("persists CLI replies into the session transcript", async () => {
    const sessionKey = "agent:main:subagent:cli-transcript";
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-transcript",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const updatedEntry = await persistCliTurnTranscript({
      body: "persist this",
      result: makeCliResult("hello from cli"),
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
    });

    const sessionFile = updatedEntry?.sessionFile;
    expect(sessionFile).toBeTruthy();
    const messages = await readSessionMessages(sessionFile!);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "persist this",
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      api: "cli",
      provider: "claude-cli",
      model: "opus",
      content: [{ type: "text", text: "hello from cli" }],
    });
  });
});
