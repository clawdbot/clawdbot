// Tests agent runner memory flush and persisted memory context handling.
import fsCore from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryFlushPlanResolver,
} from "../../plugins/memory-state.js";
import type { TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  runMemoryFlushIfNeeded,
  runPreflightCompactionIfNeeded,
  setAgentRunnerMemoryTestDeps,
} from "./agent-runner-memory.js";
import { createTestFollowupRun, writeTestSessionStore } from "./agent-runner.test-fixtures.js";
import type { ReplyOperation } from "./reply-run-registry.js";

const compactEmbeddedAgentSessionMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runEmbeddedAgentMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const incrementCompactionCountMock = vi.fn();
const ensureSelectedAgentHarnessPluginMock = vi.fn();
const ensureMemoryFlushTargetFileMock = vi.fn();
const emitAgentEventMock = vi.fn();
const TEST_MAX_FLUSH_FAILURES = 3;

function registerMemoryFlushPlanResolverForTest(resolver: MemoryFlushPlanResolver): void {
  registerMemoryCapability("memory-core", { flushPlanResolver: resolver });
}

type TestReplyOperation = ReplyOperation & {
  setPhase: ReturnType<typeof vi.fn<ReplyOperation["setPhase"]>>;
  updateSessionId: ReturnType<typeof vi.fn<ReplyOperation["updateSessionId"]>>;
};

function createReplyOperation(): TestReplyOperation {
  const now = Date.now();
  return {
    key: "test",
    sessionId: "session",
    abortSignal: new AbortController().signal,
    resetTriggered: false,
    terminalRecovery: false,
    acceptedSteeredInboundAudio: false,
    startedAtMs: now,
    lastActivityAtMs: now,
    phase: "queued",
    result: null,
    recordActivity: vi.fn(),
    hasOwnedSessionId: vi.fn((sessionId: string) => sessionId === "session"),
    setPhase: vi.fn<ReplyOperation["setPhase"]>(),
    updateSessionId: vi.fn<ReplyOperation["updateSessionId"]>(),
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
    abortByUser: vi.fn(() => true),
    abortForRestart: vi.fn(() => true),
    markTerminalRecovery: vi.fn(),
    markAcceptedSteeredInboundAudio: vi.fn(),
  };
}

type RefreshQueuedFollowupSessionParams = {
  key?: string;
  previousSessionId?: string;
  nextSessionId?: string;
  nextSessionFile?: string;
};

type ModelFallbackParams = {
  provider?: string;
  model?: string;
  abortSignal?: AbortSignal;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  fallbacksOverride?: unknown[];
  resolveAgentHarnessRuntimeOverride?: (provider: string, model: string) => string | undefined;
  prepareAgentHarnessRuntime?: (params: {
    provider: string;
    model: string;
    agentHarnessRuntimeOverride?: string;
  }) => Promise<void> | void;
};

type EmbeddedAgentParams = {
  provider?: string;
  model?: string;
  thinkLevel?: string;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
  authProfileId?: unknown;
  authProfileIdSource?: unknown;
  prompt?: string;
  transcriptPrompt?: string;
  memoryFlushWritePath?: string;
  silentExpected?: boolean;
  extraSystemPrompt?: string;
  bootstrapPromptWarningSignaturesSeen?: string[];
  bootstrapPromptWarningSignature?: string;
  abortSignal?: AbortSignal;
  isFinalFallbackAttempt?: boolean;
};

type CompactEmbeddedAgentSessionParams = {
  agentId?: string;
  agentHarnessId?: string;
  authProfileId?: string;
  contextTokenBudget?: number;
  sessionKey?: string;
  sandboxSessionKey?: string;
  currentTokenCount?: number;
  cwd?: string;
  force?: boolean;
  forcePreflight?: boolean;
  modelSelectionLocked?: boolean;
  preflightRequired?: boolean;
  preflightCompactionTrigger?: string;
  sessionFile?: string;
  sessionId?: string;
  trigger?: string;
};

function requireRefreshQueuedFollowupSessionCall(index = 0) {
  const call = refreshQueuedFollowupSessionMock.mock.calls[index]?.[0] as
    | RefreshQueuedFollowupSessionParams
    | undefined;
  if (!call) {
    throw new Error(`refreshQueuedFollowupSession call ${index} missing`);
  }
  return call;
}

function requireModelFallbackCall(index = 0) {
  const call = runWithModelFallbackMock.mock.calls[index]?.[0] as ModelFallbackParams | undefined;
  if (!call) {
    throw new Error(`runWithModelFallback call ${index} missing`);
  }
  return call;
}

function requireEmbeddedAgentCall(index = 0) {
  const call = runEmbeddedAgentMock.mock.calls[index]?.[0] as EmbeddedAgentParams | undefined;
  if (!call) {
    throw new Error(`runEmbeddedAgent call ${index} missing`);
  }
  return call;
}

function requireCompactEmbeddedAgentSessionCall(index = 0) {
  const call = compactEmbeddedAgentSessionMock.mock.calls[index]?.[0] as
    | CompactEmbeddedAgentSessionParams
    | undefined;
  if (!call) {
    throw new Error(`compactEmbeddedAgentSession call ${index} missing`);
  }
  return call;
}

describe("runMemoryFlushIfNeeded", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-unit-"));
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    runWithModelFallbackMock.mockReset().mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));
    compactEmbeddedAgentSessionMock.mockReset().mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensAfter: 42 },
    });
    runEmbeddedAgentMock.mockReset().mockResolvedValue({ payloads: [], meta: {} });
    refreshQueuedFollowupSessionMock.mockReset();
    ensureMemoryFlushTargetFileMock.mockReset().mockResolvedValue(undefined);
    ensureSelectedAgentHarnessPluginMock.mockReset().mockResolvedValue(undefined);
    emitAgentEventMock.mockReset();
    incrementCompactionCountMock.mockReset().mockImplementation(async (params) => {
      const sessionKey = String(params.sessionKey ?? "");
      if (!sessionKey || !params.sessionStore?.[sessionKey]) {
        return undefined;
      }
      const previous = params.sessionStore[sessionKey] as SessionEntry;
      const nextEntry: SessionEntry = {
        ...previous,
        compactionCount: (previous.compactionCount ?? 0) + 1,
      };
      if (typeof params.newSessionId === "string" && params.newSessionId) {
        nextEntry.sessionId = params.newSessionId;
        if (typeof params.newSessionFile === "string" && params.newSessionFile) {
          nextEntry.sessionFile = params.newSessionFile;
        } else {
          const storePath = typeof params.storePath === "string" ? params.storePath : rootDir;
          nextEntry.sessionFile = path.join(
            path.dirname(storePath),
            `${params.newSessionId}.jsonl`,
          );
        }
      }
      params.sessionStore[sessionKey] = nextEntry;
      if (typeof params.storePath === "string") {
        await writeTestSessionStore(params.storePath, sessionKey, nextEntry);
      }
      return nextEntry.compactionCount;
    });
    setAgentRunnerMemoryTestDeps({
      compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock as never,
      runWithModelFallback: runWithModelFallbackMock as never,
      runEmbeddedAgent: runEmbeddedAgentMock as never,
      ensureMemoryFlushTargetFile: ensureMemoryFlushTargetFileMock as never,
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
      incrementCompactionCount: incrementCompactionCountMock as never,
      ensureSelectedAgentHarnessPlugin: ensureSelectedAgentHarnessPluginMock as never,
      registerAgentRunContext: vi.fn() as never,
      emitAgentEvent: emitAgentEventMock as never,
      randomUUID: () => "00000000-0000-0000-0000-000000000001",
      now: () => 1_700_000_000_000,
    });
  });

  afterEach(async () => {
    setAgentRunnerMemoryTestDeps();
    cliBackendsTesting.resetDepsForTest();
    clearMemoryPluginState();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("runs a memory flush turn, rotates after compaction, and persists metadata", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);

    runEmbeddedAgentMock.mockImplementationOnce(
      async (params: {
        onAgentEvent?: (evt: { stream: string; data: { phase: string } }) => void;
      }) => {
        params.onAgentEvent?.({ stream: "compaction", data: { phase: "end" } });
        return {
          payloads: [],
          meta: { agentMeta: { sessionId: "session-rotated" } },
        };
      },
    );

    const followupRun = createTestFollowupRun();
    const result = await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {},
            },
          },
        },
      },
      followupRun,
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(result.outcome).toBe("completed");
    expect(result.sessionEntry?.sessionId).toBe("session-rotated");
    expect(followupRun.run.sessionId).toBe("session-rotated");
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const flushCall = requireEmbeddedAgentCall();
    expect(flushCall.prompt).toContain("Pre-compaction memory flush.");
    expect(flushCall.transcriptPrompt).toBe("");
    expect(flushCall.prompt).not.toBe(flushCall.transcriptPrompt);
    expect(flushCall.memoryFlushWritePath).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(flushCall.silentExpected).toBe(true);
    expect(ensureMemoryFlushTargetFileMock).toHaveBeenCalledWith({
      workspaceDir: followupRun.run.workspaceDir,
      relativePath: flushCall.memoryFlushWritePath,
    });
    expect(ensureMemoryFlushTargetFileMock.mock.invocationCallOrder[0]).toBeLessThan(
      runEmbeddedAgentMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledTimes(1);
    const refreshCall = requireRefreshQueuedFollowupSessionCall();
    expect(refreshCall.key).toBe(sessionKey);
    expect(refreshCall.previousSessionId).toBe("session");
    expect(refreshCall.nextSessionId).toBe("session-rotated");
    expect(refreshCall.nextSessionFile).toContain("session-rotated.jsonl");

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      main: SessionEntry;
    };
    expect(persisted.main.sessionId).toBe("session-rotated");
    expect(persisted.main.compactionCount).toBe(2);
    expect(persisted.main.memoryFlushCompactionCount).toBe(1);
    expect(persisted.main.memoryFlushAt).toBe(1_700_000_000_000);
  });

  it("revalidates immutable Ultra for each memory-flush fallback candidate", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      thinkingLevel: "ultra",
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        await params.run("openai", "gpt-5.6-sol");
        return {
          result: await params.run("demo", "basic"),
          provider: "demo",
          model: "basic",
          attempts: [],
        };
      },
    );
    const followupRun = createTestFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.6-sol";
    followupRun.run.thinkLevel = "ultra";

    await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: { memoryFlush: {} },
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
      followupRun,
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "openai/gpt-5.6-sol",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(runEmbeddedAgentMock.mock.calls.map((call) => call[0]?.thinkLevel)).toEqual([
      "ultra",
      "high",
    ]);
    expect(followupRun.run.thinkLevel).toBe("ultra");
  });

  it("keeps catalog-adopted sessions on Codex for memory flush turns", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "catalog-adopted-session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
      agentHarnessId: "codex",
      agentRuntimeOverride: "claude-cli",
      modelSelectionLocked: true,
      pluginExtensions: {
        codex: {
          supervision: {
            sourceThreadId: "019f-codex-thread",
            modelLocked: true,
          },
        },
      },
    };

    const result = await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
            compaction: { memoryFlush: {} },
            models: {
              "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        provider: "anthropic",
        model: "claude-opus-4-6",
        sessionId: sessionEntry.sessionId,
        sessionKey: "main",
      }),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(result.outcome).toBe("completed");
    expect(requireEmbeddedAgentCall()).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-6",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
    });
  });

  it("counts resolved error payloads as failed memory flushes", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };
    const sessionStore = { main: sessionEntry };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    const visibleErrorPayloads: Array<{ text?: string; isError?: boolean }> = [];
    runEmbeddedAgentMock.mockImplementationOnce(
      async (params: {
        onAgentEvent?: (event: { stream: string; data: { phase: string } }) => void;
      }) => {
        params.onAgentEvent?.({ stream: "compaction", data: { phase: "end" } });
        return {
          payloads: [
            { text: "normal silent maintenance reply" },
            {
              text: "⚠️ write failed: Memory flush writes are restricted to memory/2023-11-14.md; use that path only.",
              isError: true,
            },
          ],
          meta: { agentMeta: { sessionId: "session-rotated" } },
        };
      },
    );
    const followupRun = createTestFollowupRun();

    const result = await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun,
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      onVisibleErrorPayloads: (payloads) => {
        visibleErrorPayloads.push(...payloads);
      },
    });

    expect(visibleErrorPayloads).toEqual([
      {
        text: "⚠️ write failed: Memory flush writes are restricted to memory/2023-11-14.md; use that path only.",
        isError: true,
      },
    ]);
    expect(result.outcome).toBe("failed");
    expect(result.sessionEntry?.sessionId).toBe("session-rotated");
    expect(followupRun.run.sessionId).toBe("session-rotated");
    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as { main: SessionEntry };
    expect(persisted.main.sessionId).toBe("session-rotated");
    expect(persisted.main.compactionCount).toBe(2);
    expect(persisted.main.memoryFlushFailureCount).toBe(1);
    expect(persisted.main.memoryFlushAt).toBeUndefined();
  });

  it("reports restricted memory-flush write failures for visible delivery", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };
    const visibleErrorPayloads: Array<{ text?: string; isError?: boolean }> = [];
    runWithModelFallbackMock.mockRejectedValueOnce(
      new Error(
        "write failed: Memory flush writes are restricted to memory/2023-11-14.md; use that path only.",
      ),
    );

    await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun(),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      onVisibleErrorPayloads: (payloads) => {
        visibleErrorPayloads.push(...payloads);
      },
    });

    expect(visibleErrorPayloads).toEqual([
      {
        text: "⚠️ write failed: Memory flush writes are restricted to memory/2023-11-14.md; use that path only.",
        isError: true,
      },
    ]);
  });

  it("surfaces generic non-abort memory-flush failures so cron meta.error is populated (regression: #80755)", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };
    const visibleErrorPayloads: Array<{ text?: string; isError?: boolean }> = [];
    runWithModelFallbackMock.mockRejectedValueOnce(
      new Error("provider timed out after 60s while flushing memory"),
    );

    await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun(),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-7",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      onVisibleErrorPayloads: (payloads) => {
        visibleErrorPayloads.push(...payloads);
      },
    });

    expect(visibleErrorPayloads).toEqual([
      {
        text: "⚠️ provider timed out after 60s while flushing memory",
        isError: true,
      },
    ]);
  });

  it("redacts and caps generic visible memory-flush failures before delivery", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };
    const visibleErrorPayloads: Array<{ text?: string; isError?: boolean }> = [];
    const token = "sk-abcdefghijklmnopqrstuv";
    runWithModelFallbackMock.mockRejectedValueOnce(
      new Error(`provider failed with Authorization: Bearer ${token} ${"🚀".repeat(400)}`),
    );

    await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun(),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-7",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      onVisibleErrorPayloads: (payloads) => {
        visibleErrorPayloads.push(...payloads);
      },
    });

    const [payload] = visibleErrorPayloads;
    expect(payload?.isError).toBe(true);
    expect(payload?.text).toMatch(/^⚠️ provider failed with Authorization: Bearer /);
    expect(payload?.text).not.toContain(token);
    expect(payload?.text?.length).toBeLessThanOrEqual(600);
    expect(payload?.text?.endsWith("🚀…")).toBe(true);
  });

  it("does not surface user-abort errors as visible payloads (regression: #80755)", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };
    const visibleErrorPayloads: Array<{ text?: string; isError?: boolean }> = [];
    const abortErr = new Error("operation aborted by user");
    abortErr.name = "AbortError";
    runWithModelFallbackMock.mockRejectedValueOnce(abortErr);

    await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun(),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-7",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      onVisibleErrorPayloads: (payloads) => {
        visibleErrorPayloads.push(...payloads);
      },
    });

    expect(visibleErrorPayloads).toEqual([]);
  });

  it("increments and UTF-16-safely persists a capped non-abort flush failure", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    const failureMessage = `${"a".repeat(198)}🚀tail`;
    runWithModelFallbackMock.mockRejectedValueOnce(new Error(failureMessage));

    const result = await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun(),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-7",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as { main: SessionEntry };
    expect(result.outcome).toBe("failed");
    expect(persisted.main.memoryFlushFailureCount).toBe(1);
    expect(persisted.main.memoryFlushLastFailedAt).toBe(1_700_000_000_000);
    expect(persisted.main.memoryFlushLastFailureError).toBe(`${"a".repeat(198)}…`);
    expect(emitAgentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "memory_flush_failed",
          attempt: 1,
          maxAttempts: TEST_MAX_FLUSH_FAILURES,
        }),
      }),
    );
  });

  it("does not track failure on abort error", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
      memoryFlushFailureCount: 0,
    };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    const abortErr = new Error("operation aborted by user");
    abortErr.name = "AbortError";
    runWithModelFallbackMock.mockRejectedValueOnce(abortErr);

    const result = await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun(),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-7",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as { main: SessionEntry };
    expect(result.outcome).toBe("failed");
    expect(persisted.main.memoryFlushFailureCount).toBe(0);
    expect(persisted.main.memoryFlushLastFailedAt).toBeUndefined();
    expect(persisted.main.memoryFlushLastFailureError).toBeUndefined();
  });

  it("clears failure counters on successful flush", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
      memoryFlushFailureCount: 2,
      memoryFlushLastFailedAt: 1_699_999_999_000,
      memoryFlushLastFailureError: "provider crashed during flush",
    };
    await writeTestSessionStore(storePath, "main", sessionEntry);

    const result = await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun(),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-7",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as { main: SessionEntry };
    expect(result.outcome).toBe("completed");
    expect(persisted.main.memoryFlushFailureCount).toBe(0);
    expect(persisted.main.memoryFlushLastFailedAt).toBeUndefined();
    expect(persisted.main.memoryFlushLastFailureError).toBeUndefined();
  });

  it("marks flush as completed after MAX_FLUSH_FAILURES to break retry loop", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
      memoryFlushFailureCount: TEST_MAX_FLUSH_FAILURES - 1,
    };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    runWithModelFallbackMock.mockRejectedValueOnce(new Error("provider crashed during flush"));

    const visibleErrorPayloads: ReplyPayload[] = [];
    const result = await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun(),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-7",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      onVisibleErrorPayloads: (payloads) => {
        visibleErrorPayloads.push(...payloads);
      },
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as { main: SessionEntry };
    expect(result.outcome).toBe("exhausted");
    expect(persisted.main.memoryFlushCompactionCount).toBe(1);
    expect(persisted.main.memoryFlushFailureCount).toBe(TEST_MAX_FLUSH_FAILURES);
    expect(emitAgentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "memory_flush_exhausted",
          attempt: TEST_MAX_FLUSH_FAILURES,
          maxAttempts: TEST_MAX_FLUSH_FAILURES,
        }),
      }),
    );
    expect(visibleErrorPayloads[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("skipping for this cycle"),
        isError: true,
      }),
    );
  });

  it("retries flush on subsequent messages until MAX_FLUSH_FAILURES", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    runWithModelFallbackMock.mockRejectedValue(new Error("provider crashed during flush"));

    const params = {
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun(),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-7",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off" as const,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    };

    await runMemoryFlushIfNeeded(params);
    await runMemoryFlushIfNeeded({ ...params, replyOperation: createReplyOperation() });

    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(2);

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as { main: SessionEntry };
    expect(persisted.main.memoryFlushFailureCount).toBe(2);
  });

  it("next message retries flush after failure", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    runWithModelFallbackMock.mockRejectedValueOnce(new Error("provider crashed during flush"));

    const params = {
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun(),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-7",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off" as const,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    };

    await runMemoryFlushIfNeeded(params);
    await runMemoryFlushIfNeeded({ ...params, replyOperation: createReplyOperation() });

    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(2);
  });

  it("runs memory flush on the configured maintenance model without active fallbacks", async () => {
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      model: "ollama/qwen3:8b",
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };

    const replyOperation = createReplyOperation();
    await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude",
              fallbacks: ["openai/gpt-5.4"],
            },
            compaction: {
              memoryFlush: {
                model: "ollama/qwen3:8b",
              },
            },
          },
        },
      },
      followupRun: createTestFollowupRun({ provider: "anthropic", model: "claude" }),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation,
    });

    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    const fallbackCall = requireModelFallbackCall();
    expect(fallbackCall.provider).toBe("ollama");
    expect(fallbackCall.model).toBe("qwen3:8b");
    expect(fallbackCall.abortSignal).toBe(replyOperation.abortSignal);
    expect(fallbackCall.sessionId).toBe("session");
    expect(fallbackCall.fallbacksOverride).toEqual([]);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const agentCall = requireEmbeddedAgentCall();
    expect(agentCall.provider).toBe("ollama");
    expect(agentCall.model).toBe("qwen3:8b");
    expect(agentCall.abortSignal).toBe(replyOperation.abortSignal);
    expect(agentCall.authProfileId).toBeUndefined();
    expect(agentCall.authProfileIdSource).toBeUndefined();
  });

  it("loads the selected harness before memory-flush fallback preflight", async () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {},
          },
        },
      },
    };
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
      agentRuntimeOverride: "codex",
    };
    const runtimePolicySessionKey = "agent:main:telegram:default:direct:12345";
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: {
        provider: string;
        model: string;
        run: (
          provider: string,
          model: string,
          options?: { isFinalFallbackAttempt?: boolean },
        ) => Promise<unknown>;
      }) => ({
        result: await params.run(params.provider, params.model, {
          isFinalFallbackAttempt: false,
        }),
        provider: params.provider,
        model: params.model,
        attempts: [],
      }),
    );

    await runMemoryFlushIfNeeded({
      cfg,
      followupRun: createTestFollowupRun({
        agentId: "main",
        sessionKey: "main",
        runtimePolicySessionKey,
        workspaceDir: "/workspace",
        provider: "openai",
        model: "gpt-5.4",
      }),
      sessionCtx: { Provider: "telegram" } as unknown as TemplateContext,
      defaultModel: "openai/gpt-5.4",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      runtimePolicySessionKey,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const fallbackCall = requireModelFallbackCall();
    expect(fallbackCall.agentId).toBe("main");
    expect(fallbackCall.sessionKey).toBe(runtimePolicySessionKey);
    expect(fallbackCall.resolveAgentHarnessRuntimeOverride?.("openai", "gpt-5.4")).toBe("codex");
    expect(requireEmbeddedAgentCall().isFinalFallbackAttempt).toBe(false);

    await fallbackCall.prepareAgentHarnessRuntime?.({
      provider: "openai",
      model: "gpt-5.4",
      agentHarnessRuntimeOverride: "codex",
    });

    expect(ensureSelectedAgentHarnessPluginMock).toHaveBeenCalledWith({
      config: cfg,
      provider: "openai",
      modelId: "gpt-5.4",
      agentId: "main",
      sessionKey: runtimePolicySessionKey,
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      workspaceDir: "/workspace",
    });
  });

  it("ignores stale runtime pins before memory-flush fallback preflight", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
      agentRuntimeOverride: "unsupported-runtime",
    };

    await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.4",
      }),
      sessionCtx: { Provider: "telegram" } as unknown as TemplateContext,
      defaultModel: "openai/gpt-5.4",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(
      requireModelFallbackCall().resolveAgentHarnessRuntimeOverride?.("openai", "gpt-5.4"),
    ).toBeUndefined();
  });

  it("skips memory flush for CLI providers", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };

    const result = await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { cliBackends: { "codex-cli": { command: "codex" } } } } },
      followupRun: createTestFollowupRun({ provider: "codex-cli" }),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "codex-cli/gpt-5.5",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("skips memory flush for compatible CLI session runtime pins", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
      agentRuntimeOverride: "claude-cli",
    };

    const result = await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("uses runtime policy session key when checking memory-flush sandbox writability", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };

    const result = await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            sandbox: {
              mode: "non-main",
              scope: "agent",
              workspaceAccess: "ro",
            },
            compaction: {
              memoryFlush: {},
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        sessionKey: "agent:main:main",
        runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
      }),
      sessionCtx: { Provider: "telegram" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("continues when preflight compaction reports the session is already under target", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "already under target",
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
      agentHarnessId: "openclaw",
      modelSelectionLocked: true,
    };
    const onCompactionNotice = vi.fn();

    const entry = await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "agent:main:main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100,
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      onCompactionNotice,
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
      trigger: "budget",
      force: true,
      forcePreflight: true,
      preflightRequired: true,
      preflightCompactionTrigger: "tokens",
      deferOwningContextEngineCompaction: false,
      contextTokenBudget: 100,
      agentHarnessId: "openclaw",
      modelSelectionLocked: true,
    });
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
    expect(onCompactionNotice).toHaveBeenNthCalledWith(1, "start");
    expect(onCompactionNotice).toHaveBeenNthCalledWith(2, "skipped");
  });

  it("fails when required preflight context-engine compaction is deferred to background maintenance", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "deferred to background context-engine maintenance",
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
    };

    await expect(
      runPreflightCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "agent:main:main",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        agentCfgContextTokens: 100,
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
        sessionKey: "agent:main:main",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        replyOperation: createReplyOperation(),
      }),
    ).rejects.toThrow(
      "Preflight compaction required but failed: deferred to background context-engine maintenance",
    );

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
  });

  it("passes runtime policy session key to preflight compaction sandbox resolution", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "agent:main:main",
        cwd: "/tmp/task-repo",
        runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100,
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.sessionKey).toBe("agent:main:main");
    expect(compactCall.cwd).toBe("/tmp/task-repo");
    expect(compactCall.sandboxSessionKey).toBe("agent:main:telegram:default:direct:12345");
  });

  it.each([
    ["stale_thread_binding", "thread not found: <codex-thread-id>"],
    ["missing_thread_binding", "no thread binding for session"],
  ])(
    "fails required preflight compaction after native harness %s failure",
    async (failureReason, reason) => {
      const sessionFile = path.join(rootDir, "session.jsonl");
      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
        "utf8",
      );
      registerMemoryFlushPlanResolverForTest(() => ({
        softThresholdTokens: 1,
        forceFlushTranscriptBytes: 1_000_000_000,
        reserveTokensFloor: 0,
        prompt: "Pre-compaction memory flush.\nNO_REPLY",
        systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
        relativePath: "memory/2023-11-14.md",
      }));
      compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason,
        failure: { reason: failureReason },
      });
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        sessionFile,
        updatedAt: Date.now(),
        totalTokens: 120,
        totalTokensFresh: true,
      };
      const sessionStore = { "agent:main:telegram:group:redacted": sessionEntry };

      await expect(
        runPreflightCompactionIfNeeded({
          cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
          followupRun: createTestFollowupRun({
            sessionId: "session",
            sessionFile,
            sessionKey: "agent:main:telegram:group:redacted",
          }),
          defaultModel: "anthropic/claude-opus-4-6",
          agentCfgContextTokens: 100,
          sessionEntry,
          sessionStore,
          sessionKey: "agent:main:telegram:group:redacted",
          storePath: path.join(rootDir, "sessions.json"),
          isHeartbeat: false,
          replyOperation: createReplyOperation(),
        }),
      ).rejects.toThrow(`Preflight compaction required but failed: ${reason}`);

      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
      expect(incrementCompactionCountMock).not.toHaveBeenCalled();
    },
  );

  it("fails required preflight compaction after an unstructured thread-not-found failure", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "thread not found: <codex-thread-id>",
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
    };
    const sessionStore = { "agent:main:telegram:group:redacted": sessionEntry };

    await expect(
      runPreflightCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "agent:main:telegram:group:redacted",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        agentCfgContextTokens: 100,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:telegram:group:redacted",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        replyOperation: createReplyOperation(),
      }),
    ).rejects.toThrow(
      "Preflight compaction required but failed: thread not found: <codex-thread-id>",
    );

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
  });

  it("still fails preflight compaction for non-binding native harness failures", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "auth profile mismatch",
      failure: { reason: "auth_profile_mismatch" },
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
    };
    const sessionStore = { "agent:main:telegram:group:redacted": sessionEntry };

    await expect(
      runPreflightCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "agent:main:telegram:group:redacted",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        agentCfgContextTokens: 100,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:telegram:group:redacted",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        replyOperation: createReplyOperation(),
      }),
    ).rejects.toThrow("Preflight compaction required but failed: auth profile mismatch");

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
  });

  it("passes resolved context budget and auth profile to preflight compaction", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 245_000,
      totalTokensFresh: true,
      compactionCount: 0,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        authProfileId: "anthropic:claude@martian.engineering",
        provider: "anthropic",
        model: "claude-opus-4-6",
        sessionKey: "agent:main:main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 258_000,
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.authProfileId).toBe("anthropic:claude@martian.engineering");
    expect(compactCall.contextTokenBudget).toBe(258_000);
  });
  it("preflight compacts a fresh session when the current prompt estimate pushes the next request over budget", async () => {
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 0,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 10,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 985,
      totalTokensFresh: true,
      compactionCount: 0,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        provider: "anthropic",
        model: "claude",
        sessionKey: "agent:main:main",
      }),
      promptForEstimate: "Please summarize the entire design discussion above. ".repeat(8),
      defaultModel: "anthropic/claude",
      agentCfgContextTokens: 1000,
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
  });
  it("does not preflight compact a fresh session when only accumulated output tokens are large and the latest output keeps the request under budget", async () => {
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 0,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 10,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 985,
      outputTokens: 50_000,
      totalTokensFresh: true,
      compactionCount: 0,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        provider: "anthropic",
        model: "claude",
        sessionKey: "agent:main:main",
      }),
      promptForEstimate: "",
      defaultModel: "anthropic/claude",
      agentCfgContextTokens: 1000,
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });
  it("updates the active preflight run after transcript rotation", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    const successorFile = path.join(rootDir, "session-rotated.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        tokensAfter: 42,
        sessionId: "session-rotated",
        sessionFile: successorFile,
      },
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };
    const sessionStore = { "agent:main:main": sessionEntry };
    const followupRun = createTestFollowupRun({
      sessionId: "session",
      sessionFile,
      sessionKey: "agent:main:main",
    });
    const replyOperation = createReplyOperation();

    const entry = await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation,
    });

    expect(entry?.sessionId).toBe("session-rotated");
    expect(entry?.sessionFile).toBe(successorFile);
    expect(followupRun.run.sessionId).toBe("session-rotated");
    expect(followupRun.run.sessionFile).toBe(successorFile);
    expect(replyOperation.updateSessionId).toHaveBeenCalledWith("session-rotated");
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: "agent:main:main",
      previousSessionId: "session",
      nextSessionId: "session-rotated",
      nextSessionFile: successorFile,
    });
  });

  it("includes recent output tokens when deciding preflight compaction", async () => {
    const sessionFile = path.join(rootDir, "session-usage.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        message: {
          role: "assistant",
          content: "large answer",
          usage: { input: 90_000, output: 10_000 },
        },
      })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.currentTokenCount).toBeGreaterThanOrEqual(100_000);
  });

  it("reuses the transcript tail scan stat when memory flush needs usage and byte size", async () => {
    const sessionFile = path.join(rootDir, "memory-flush-usage-and-size.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        message: {
          role: "assistant",
          content: "large answer",
          usage: { input: 80_000, output: 4_000 },
        },
      })}\n`,
      "utf8",
    );
    const originalStat = fsCore.promises.stat.bind(fsCore.promises);
    const statSpy = vi
      .spyOn(fsCore.promises, "stat")
      .mockImplementation(async (target, options) => originalStat(target, options));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    let directTranscriptStats: unknown[];
    try {
      await runMemoryFlushIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "main",
        }),
        sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
        defaultModel: "anthropic/claude-opus-4-6",
        agentCfgContextTokens: 100_000,
        resolvedVerboseLevel: "off",
        sessionEntry,
        sessionStore: { main: sessionEntry },
        sessionKey: "main",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        replyOperation: createReplyOperation(),
      });
      directTranscriptStats = statSpy.mock.calls.filter(
        ([target]) => String(target) === sessionFile,
      );
    } finally {
      statSpy.mockRestore();
    }

    expect(directTranscriptStats).toEqual([]);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  });

  it("fails when required preflight compaction returns an unknown successful no-op", async () => {
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "plugin already stored this turn",
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 180_499,
      totalTokensFresh: true,
      compactionCount: 0,
    };
    const sessionStore = { main: sessionEntry };
    const replyOperation = createReplyOperation();

    await expect(
      runPreflightCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionKey: "main",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        agentCfgContextTokens: 200_000,
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        replyOperation,
      }),
    ).rejects.toThrow("Preflight compaction required but failed: plugin already stored this turn");

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.contextTokenBudget).toBe(200_000);
    expect(replyOperation.setPhase).toHaveBeenCalledWith("preflight_compacting");
    expect(replyOperation.updateSessionId).not.toHaveBeenCalled();
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSessionMock).not.toHaveBeenCalled();
  });

  it("skips OpenClaw preflight compaction for explicit Codex runtime overrides", async () => {
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 347_000,
      totalTokensFresh: false,
      agentRuntimeOverride: "codex",
      agentHarnessId: "openclaw",
    };

    const entry = await runPreflightCompactionIfNeeded({
      cfg: {
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5", contextWindow: 1_000_000 }] },
          },
        },
        agents: { defaults: { compaction: { memoryFlush: {} } } },
      } as never,
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "session",
        sessionKey: "main",
      }),
      defaultModel: "gpt-5.5",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("skips fresh persisted token totals for explicit Codex runtime overrides", async () => {
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 347_000,
      totalTokensFresh: true,
      agentRuntimeOverride: "codex",
      agentHarnessId: "openclaw",
    };

    const entry = await runPreflightCompactionIfNeeded({
      cfg: {
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] },
          },
        },
        agents: { defaults: { compaction: { memoryFlush: {} } } },
      } as never,
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "session",
        sessionKey: "main",
      }),
      defaultModel: "gpt-5.5",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("skips preflight compaction for compatible CLI session runtime pins", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 347_000,
      totalTokensFresh: true,
      agentRuntimeOverride: "claude-cli",
    };

    const entry = await runPreflightCompactionIfNeeded({
      cfg: {
        models: {
          providers: {
            anthropic: { models: [{ id: "claude-opus-4-6", contextWindow: 350_000 }] },
          },
        },
        agents: { defaults: { compaction: { memoryFlush: {} } } },
      } as never,
      followupRun: createTestFollowupRun({
        provider: "anthropic",
        model: "claude-opus-4-6",
        sessionId: "session",
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("keeps the OpenAI API context window for persisted OpenClaw runtime overrides", async () => {
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 347_000,
      totalTokensFresh: false,
      agentRuntimeOverride: "openclaw",
    };

    const entry = await runPreflightCompactionIfNeeded({
      cfg: {
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5", contextWindow: 1_000_000 }] },
          },
        },
        agents: { defaults: { compaction: { memoryFlush: {} } } },
      } as never,
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "session",
        sessionKey: "main",
      }),
      defaultModel: "gpt-5.5",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("uses the active run sessionFile when the session entry has no transcript path", async () => {
    const sessionFile = path.join(rootDir, "active-run-session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        message: {
          role: "assistant",
          content: "large answer",
          usage: { input: 90_000, output: 8_000 },
        },
      })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.sessionId).toBe("session");
    expect(compactCall.sessionFile).toContain("active-run-session.jsonl");
  });

  it("does not treat unavailable Anthropic context as transcript prompt usage", async () => {
    const sessionFile = path.join(rootDir, "unavailable-context-session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        message: {
          role: "assistant",
          content: "small answer",
          usage: {
            input: 12,
            output: 15_104,
            cacheRead: 819_661,
            cacheWrite: 93_130,
            contextUsage: { state: "unavailable" },
            totalTokens: 927_907,
          },
        },
      })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("keeps preflight compaction conservative for content appended after latest usage", async () => {
    const sessionFile = path.join(rootDir, "post-usage-tail-session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: "small answer",
            usage: { input: 40_000, output: 2_000 },
          },
        }),
        JSON.stringify({
          message: {
            role: "tool",
            content: `large interrupted tool output ${"x".repeat(450_000)}`,
          },
        }),
      ].join("\n"),
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.currentTokenCount).toBeGreaterThan(100_000);
  });

  it("combines latest usage with post-usage tail pressure for preflight compaction", async () => {
    const sessionFile = path.join(rootDir, "combined-tail-pressure-session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: "small answer",
            usage: { input: 86_000, output: 2_000 },
          },
        }),
        JSON.stringify({
          message: {
            role: "tool",
            content: `moderate interrupted tool output ${"x".repeat(36_000)}`,
          },
        }),
      ].join("\n"),
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.currentTokenCount).toBeGreaterThanOrEqual(96_000);
  });

  it("does not count bytes from a large latest usage record as post-usage tail pressure", async () => {
    const sessionFile = path.join(rootDir, "large-usage-record-session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          id: "session",
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: `large answer ${"x".repeat(300_000)}`,
            usage: { input: 40_000, output: 2_000 },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };
    const entry = await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("does not treat raw transcript metadata bytes as token pressure", async () => {
    const sessionFile = path.join(rootDir, "metadata-heavy-session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          id: "session",
        }),
        JSON.stringify({
          type: "custom",
          payload: "x".repeat(450_000),
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "small answer",
            usage: { input: 40_000, output: 2_000 },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };
    const originalStat = fsCore.promises.stat.bind(fsCore.promises);
    const statSpy = vi
      .spyOn(fsCore.promises, "stat")
      .mockImplementation(async (target, options) => originalStat(target, options));

    let entry: SessionEntry | undefined;
    let directTranscriptStats: unknown[];
    try {
      entry = await runPreflightCompactionIfNeeded({
        cfg: {
          agents: {
            defaults: {
              compaction: {
                memoryFlush: {},
                truncateAfterCompaction: true,
                maxActiveTranscriptBytes: "10mb",
              },
            },
          },
        },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "main",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        agentCfgContextTokens: 100_000,
        sessionEntry,
        sessionStore: { main: sessionEntry },
        sessionKey: "main",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        replyOperation: createReplyOperation(),
      });
      directTranscriptStats = statSpy.mock.calls.filter(
        ([target]) => String(target) === sessionFile,
      );
    } finally {
      statSpy.mockRestore();
    }

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
    expect(directTranscriptStats).toEqual([]);
  });

  it("triggers preflight compaction when the active transcript exceeds the configured byte threshold", async () => {
    const sessionFile = path.join(rootDir, "large-session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(256) } })}\n`,
      "utf8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 10,
      totalTokensFresh: true,
      compactionCount: 0,
    };
    const sessionStore = { main: sessionEntry };
    const replyOperation = createReplyOperation();

    const entry = await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: "10b",
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation,
    });

    expect(entry?.compactionCount).toBe(1);
    expect(replyOperation.setPhase).toHaveBeenCalledWith("preflight_compacting");
    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.sessionId).toBe("session");
    expect(compactCall.trigger).toBe("budget");
    expect(compactCall.currentTokenCount).toBe(12);
    expect(compactCall.sessionFile).toContain("large-session.jsonl");
  });

  it("emits preflight compaction notices around a successful budget compaction", async () => {
    const sessionFile = path.join(rootDir, "notify-session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
      compactionCount: 0,
    };
    const onCompactionNotice = vi.fn();

    await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              notifyUser: true,
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: "10b",
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      onCompactionNotice,
    });

    expect(onCompactionNotice).toHaveBeenNthCalledWith(1, "start");
    expect(onCompactionNotice).toHaveBeenNthCalledWith(2, "end");
  });

  it("emits an incomplete preflight compaction notice when post-compaction state update throws", async () => {
    const sessionFile = path.join(rootDir, "notify-failed-session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    incrementCompactionCountMock.mockRejectedValueOnce(new Error("count update failed"));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
      compactionCount: 0,
    };
    const onCompactionNotice = vi.fn();

    await expect(
      runPreflightCompactionIfNeeded({
        cfg: {
          agents: {
            defaults: {
              compaction: {
                notifyUser: true,
                truncateAfterCompaction: true,
                maxActiveTranscriptBytes: "10b",
              },
            },
          },
        },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "main",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        agentCfgContextTokens: 100_000,
        sessionEntry,
        sessionStore: { main: sessionEntry },
        sessionKey: "main",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        replyOperation: createReplyOperation(),
        onCompactionNotice,
      }),
    ).rejects.toThrow("count update failed");

    expect(onCompactionNotice).toHaveBeenNthCalledWith(1, "start");
    expect(onCompactionNotice).toHaveBeenNthCalledWith(2, "incomplete");
  });

  it("keeps the active transcript byte threshold inactive unless transcript rotation is enabled", async () => {
    const sessionFile = path.join(rootDir, "large-session-no-rotation.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(256) } })}\n`,
      "utf8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 10,
      totalTokensFresh: true,
      compactionCount: 0,
    };

    const entry = await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "10b",
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("uses configured prompts and stored bootstrap warning signatures", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
        bootstrapTruncation: {
          warningMode: "once",
          warningShown: true,
          promptWarningSignature: "sig-b",
          warningSignaturesSeen: ["sig-a", "sig-b"],
          truncatedFiles: 1,
          nearLimitFiles: 0,
          totalNearLimit: false,
        },
      },
    };
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Write notes.\nNO_REPLY to memory/2023-11-14.md and MEMORY.md",
      systemPrompt: "Flush memory now. NO_REPLY memory/YYYY-MM-DD.md MEMORY.md",
      relativePath: "memory/2023-11-14.md",
    }));

    await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({ extraSystemPrompt: "extra system" }),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const flushCall = requireEmbeddedAgentCall();
    expect(flushCall.prompt).toContain("Write notes.");
    expect(flushCall.prompt).toContain("NO_REPLY");
    expect(flushCall.prompt).toContain("MEMORY.md");
    expect(flushCall.transcriptPrompt).toBe("");
    expect(flushCall.extraSystemPrompt).toContain("extra system");
    expect(flushCall.extraSystemPrompt).toContain("Flush memory now.");
    expect(flushCall.memoryFlushWritePath).toBe("memory/2023-11-14.md");
    expect(flushCall.silentExpected).toBe(true);
    expect(flushCall.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(flushCall.bootstrapPromptWarningSignature).toBe("sig-b");
  });
});
