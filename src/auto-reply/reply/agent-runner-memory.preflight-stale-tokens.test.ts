import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryFlushPlanResolver,
} from "../../plugins/memory-state.test-fixtures.js";
import { runPreflightCompactionIfNeeded } from "./agent-runner-memory.js";
import { setAgentRunnerMemoryTestDeps } from "./agent-runner-memory.test-support.js";
import { createTestFollowupRun, writeTestSessionStore } from "./agent-runner.test-fixtures.js";
import type { ReplyOperation } from "./reply-run-registry.js";

const compactEmbeddedAgentSessionMock = vi.fn();

function createReplyOperation(): ReplyOperation {
  return {
    key: "test",
    sessionId: "session",
    abortSignal: new AbortController().signal,
    resetTriggered: false,
    phase: "queued",
    result: null,
    startedAtMs: Date.now(),
    lastActivityAtMs: Date.now(),
    recordActivity: vi.fn(),
    setPhase: vi.fn(),
    updateSessionId: vi.fn(),
    attachBackend: vi.fn(),
    detachBackend: vi.fn(),
    freezeAbort: vi.fn(),
    retainFailureUntilComplete: vi.fn(),
    complete: vi.fn(),
    completeThen: vi.fn((afterClear: () => void) => {
      afterClear();
    }),
    completeWithAfterClearBarrier: vi.fn(),
    fail: vi.fn(),
    abortByUser: vi.fn(),
    abortForRestart: vi.fn(),
  } as unknown as ReplyOperation;
}

function registerMemoryFlushPlanResolverForTest(resolver: MemoryFlushPlanResolver): void {
  registerMemoryCapability("memory-core", { flushPlanResolver: resolver });
}

describe("runPreflightCompactionIfNeeded stale totalTokens gating", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preflight-stale-"));
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    compactEmbeddedAgentSessionMock.mockReset().mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensAfter: 42 },
    });
    setAgentRunnerMemoryTestDeps({
      compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock as never,
      incrementCompactionCount: vi.fn() as never,
      refreshQueuedFollowupSession: vi.fn() as never,
      registerAgentRunContext: vi.fn() as never,
      emitAgentEvent: vi.fn() as never,
    });
  });

  afterEach(async () => {
    setAgentRunnerMemoryTestDeps();
    cliBackendsTesting.resetDepsForTest();
    clearMemoryPluginState();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  async function runWithEntry(sessionEntry: SessionEntry, sessionFile: string) {
    return await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "agent:main:main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });
  }

  it("does not compact when totalTokens is large but stale and the real transcript is small", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(2_000) } })}\n`,
      "utf8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 200_000,
      totalTokensFresh: false,
    };
    await writeTestSessionStore(
      path.join(rootDir, "sessions.json"),
      "agent:main:main",
      sessionEntry,
    );

    const entry = await runWithEntry(sessionEntry, sessionFile);

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("compacts when totalTokens is large and fresh", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(2_000) } })}\n`,
      "utf8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 200_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    };
    await writeTestSessionStore(
      path.join(rootDir, "sessions.json"),
      "agent:main:main",
      sessionEntry,
    );

    await runWithEntry(sessionEntry, sessionFile);

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "the configured roster default for an embedded provider",
      runAgentId: undefined,
      expectedAgentId: "ops",
      provider: "anthropic",
      model: "claude-opus-4-6",
      expectsCompaction: true,
    },
    {
      name: "the explicitly prepared agent for an embedded provider",
      runAgentId: "worker",
      expectedAgentId: "worker",
      provider: "anthropic",
      model: "claude-opus-4-6",
      expectsCompaction: true,
    },
    {
      name: "the configured roster default before provider runtime selection",
      runAgentId: undefined,
      expectedAgentId: "ops",
      provider: "openai",
      model: "gpt-5.6-luna",
      expectsCompaction: false,
    },
    {
      name: "the explicitly prepared agent before provider runtime selection",
      runAgentId: "worker",
      expectedAgentId: "worker",
      provider: "openai",
      model: "gpt-5.6-luna",
      expectsCompaction: false,
    },
  ])(
    "resolves an unscoped session key with $name",
    async ({ runAgentId, expectedAgentId, provider, model, expectsCompaction }) => {
      const sessionFile = path.join(rootDir, "session.jsonl");
      const storePath = path.join(rootDir, "sessions.json");
      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({ message: { role: "user", content: "x".repeat(2_000) } })}\n`,
        "utf8",
      );
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        sessionFile,
        updatedAt: Date.now(),
        totalTokens: 200_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      };
      await writeTestSessionStore(storePath, "main", sessionEntry);

      const result = await runPreflightCompactionIfNeeded({
        cfg: {
          agents: {
            list: [{ id: "ops", default: true }, { id: "worker" }],
            defaults: { compaction: { memoryFlush: {} } },
          },
        },
        followupRun: createTestFollowupRun({
          agentId: runAgentId,
          sessionId: "session",
          sessionFile,
          sessionKey: "main",
          provider,
          model,
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        agentCfgContextTokens: 100_000,
        sessionEntry,
        sessionStore: { main: sessionEntry },
        sessionKey: "main",
        storePath,
        isHeartbeat: false,
        replyOperation: createReplyOperation(),
      });

      expect(result).toBe(sessionEntry);
      if (expectsCompaction) {
        expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionTarget: expect.objectContaining({ agentId: expectedAgentId }),
          }),
        );
      } else {
        expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
      }
    },
  );
});
