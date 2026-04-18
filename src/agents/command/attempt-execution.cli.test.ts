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
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("clears stale Claude CLI session IDs before retrying after session expiration", async () => {
    const sessionKey = "agent:main:subagent:cli-expired";
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
