import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryFlushPlanResolver,
} from "../../plugins/memory-state.js";
import type { TemplateContext } from "../templating.js";
import {
  runMemoryFlushIfNeeded,
  runPreflightCompactionIfNeeded,
  setAgentRunnerMemoryTestDeps,
} from "./agent-runner-memory.js";
import { createTestFollowupRun, writeTestSessionStore } from "./agent-runner.test-fixtures.js";

const compactEmbeddedPiSessionMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runEmbeddedPiAgentMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const incrementCompactionCountMock = vi.fn();

function registerMemoryFlushPlanResolverForTest(resolver: MemoryFlushPlanResolver): void {
  registerMemoryCapability("memory-core", { flushPlanResolver: resolver });
}

function createReplyOperation() {
  return {
    abortSignal: new AbortController().signal,
    setPhase: vi.fn(),
    updateSessionId: vi.fn(),
  } as never;
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
  fallbacksOverride?: unknown[];
};

type EmbeddedPiAgentParams = {
  provider?: string;
  model?: string;
  authProfileId?: unknown;
  authProfileIdSource?: unknown;
  prompt?: string;
  transcriptPrompt?: string;
  memoryFlushWritePath?: string;
  silentExpected?: boolean;
  extraSystemPrompt?: string;
  bootstrapPromptWarningSignaturesSeen?: string[];
  bootstrapPromptWarningSignature?: string;
};

type CompactEmbeddedPiSessionParams = {
  sessionKey?: string;
  sandboxSessionKey?: string;
  currentTokenCount?: number;
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

function requireEmbeddedPiAgentCall(index = 0) {
  const call = runEmbeddedPiAgentMock.mock.calls[index]?.[0] as EmbeddedPiAgentParams | undefined;
  if (!call) {
    throw new Error(`runEmbeddedPiAgent call ${index} missing`);
  }
  return call;
}

function requireCompactEmbeddedPiSessionCall(index = 0) {
  const call = compactEmbeddedPiSessionMock.mock.calls[index]?.[0] as
    | CompactEmbeddedPiSessionParams
    | undefined;
  if (!call) {
    throw new Error(`compactEmbeddedPiSession call ${index} missing`);
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
    compactEmbeddedPiSessionMock.mockReset().mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensAfter: 42 },
    });
    runEmbeddedPiAgentMock.mockReset().mockResolvedValue({ payloads: [], meta: {} });
    refreshQueuedFollowupSessionMock.mockReset();
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
      compactEmbeddedPiSession: compactEmbeddedPiSessionMock as never,
      runWithModelFallback: runWithModelFallbackMock as never,
      runEmbeddedPiAgent: runEmbeddedPiAgentMock as never,
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
      incrementCompactionCount: incrementCompactionCountMock as never,
      registerAgentRunContext: vi.fn() as never,
      randomUUID: () => "00000000-0000-0000-0000-000000000001",
      now: () => 1_700_000_000_000,
    });
  });

  afterEach(async () => {
    setAgentRunnerMemoryTestDeps();
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

    runEmbeddedPiAgentMock.mockImplementationOnce(
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
    const entry = await runMemoryFlushIfNeeded({
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

    expect(entry?.sessionId).toBe("session-rotated");
    expect(followupRun.run.sessionId).toBe("session-rotated");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const flushCall = requireEmbeddedPiAgentCall();
    expect(flushCall.prompt).toContain("Pre-compaction memory flush.");
    expect(flushCall.transcriptPrompt).toBe("");
    expect(flushCall.prompt).not.toBe(flushCall.transcriptPrompt);
    expect(flushCall.memoryFlushWritePath).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(flushCall.silentExpected).toBe(true);
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

  it("reports memory-flush error payloads for visible delivery", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };
    const visibleErrorPayloads: Array<{ text?: string; isError?: boolean }> = [];
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [
        { text: "normal silent maintenance reply" },
        {
          text: "⚠️ write failed: Memory flush writes are restricted to memory/2023-11-14.md; use that path only.",
          isError: true,
        },
      ],
      meta: {},
    });

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
      new Error(`provider failed with Authorization: Bearer ${token} ${"x".repeat(800)}`),
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
    expect(payload?.text?.endsWith("…")).toBe(true);
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
      replyOperation: createReplyOperation(),
    });

    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    const fallbackCall = requireModelFallbackCall();
    expect(fallbackCall.provider).toBe("ollama");
    expect(fallbackCall.model).toBe("qwen3:8b");
    expect(fallbackCall.fallbacksOverride).toEqual([]);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const agentCall = requireEmbeddedPiAgentCall();
    expect(agentCall.provider).toBe("ollama");
    expect(agentCall.model).toBe("qwen3:8b");
    expect(agentCall.authProfileId).toBeUndefined();
    expect(agentCall.authProfileIdSource).toBeUndefined();
  });

  it("skips memory flush for CLI providers", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };

    const entry = await runMemoryFlushIfNeeded({
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

    expect(entry).toBe(sessionEntry);
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("uses runtime policy session key when checking memory-flush sandbox writability", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };

    const entry = await runMemoryFlushIfNeeded({
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

    expect(entry).toBe(sessionEntry);
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
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
      totalTokensFresh: false,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "agent:main:main",
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

    expect(compactEmbeddedPiSessionMock).toHaveBeenCalledTimes(1);
    const compactCall = requireCompactEmbeddedPiSessionCall();
    expect(compactCall.sessionKey).toBe("agent:main:main");
    expect(compactCall.sandboxSessionKey).toBe("agent:main:telegram:default:direct:12345");
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
    compactEmbeddedPiSessionMock.mockResolvedValueOnce({
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
    const updateSessionId = vi.fn();
    const replyOperation = {
      abortSignal: new AbortController().signal,
      setPhase: vi.fn(),
      updateSessionId,
    } as never;

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
    expect(updateSessionId).toHaveBeenCalledWith("session-rotated");
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

    const compactCall = requireCompactEmbeddedPiSessionCall();
    expect(compactCall.currentTokenCount).toBeGreaterThanOrEqual(100_000);
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

    expect(compactEmbeddedPiSessionMock).toHaveBeenCalledTimes(1);
    const compactCall = requireCompactEmbeddedPiSessionCall();
    expect(compactCall.sessionId).toBe("session");
    expect(compactCall.sessionFile).toContain("active-run-session.jsonl");
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

    const compactCall = requireCompactEmbeddedPiSessionCall();
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

    const compactCall = requireCompactEmbeddedPiSessionCall();
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
    expect(compactEmbeddedPiSessionMock).not.toHaveBeenCalled();
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

    const entry = await runPreflightCompactionIfNeeded({
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

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedPiSessionMock).not.toHaveBeenCalled();
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
    const replyOperation = {
      abortSignal: new AbortController().signal,
      setPhase: vi.fn(),
      updateSessionId: vi.fn(),
    };

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
      replyOperation: replyOperation as never,
    });

    expect(entry?.compactionCount).toBe(1);
    expect(replyOperation.setPhase).toHaveBeenCalledWith("preflight_compacting");
    const compactCall = requireCompactEmbeddedPiSessionCall();
    expect(compactCall.sessionId).toBe("session");
    expect(compactCall.trigger).toBe("budget");
    expect(compactCall.currentTokenCount).toBe(10);
    expect(compactCall.sessionFile).toContain("large-session.jsonl");
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
    expect(compactEmbeddedPiSessionMock).not.toHaveBeenCalled();
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

    const flushCall = requireEmbeddedPiAgentCall();
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
