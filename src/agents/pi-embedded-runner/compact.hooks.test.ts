import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyExtraParamsToAgentMock,
  contextEngineCompactMock,
  createOpenClawCodingToolsMock,
  ensureRuntimePluginsLoaded,
  estimateTokensMock,
  getMemorySearchManagerMock,
  hookRunner,
  loadCompactHooksHarness,
  maybeCompactAgentHarnessSessionMock,
  registerProviderStreamForModelMock,
  resolveContextEngineMock,
  resolveEmbeddedAgentStreamFnMock,
  resolveMemorySearchConfigMock,
  resolveModelMock,
  resolveSandboxContextMock,
  resolveSessionAgentIdMock,
  resolveSessionAgentIdsMock,
  rotateTranscriptAfterCompactionMock,
  resetCompactHooksHarnessMocks,
  resetCompactSessionStateMocks,
  sessionAbortCompactionMock,
  sessionMessages,
  sessionCompactImpl,
  triggerInternalHook,
} from "./compact.hooks.harness.js";

let compactEmbeddedPiSessionDirect: typeof import("./compact.js").compactEmbeddedPiSessionDirect;
let compactEmbeddedPiSession: typeof import("./compact.queued.js").compactEmbeddedPiSession;
let compactTesting: typeof import("./compact.js").__testing;
let onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;

const TEST_SESSION_ID = "session-1";
const TEST_SESSION_KEY = "agent:main:session-1";
const TEST_SESSION_FILE = "/tmp/session.jsonl";
const TEST_WORKSPACE_DIR = "/tmp";
const TEST_CUSTOM_INSTRUCTIONS = "focus on decisions";
type SessionHookEvent = {
  type?: string;
  action?: string;
  sessionKey?: string;
  context?: Record<string, unknown>;
};
type PostCompactionSyncParams = {
  reason: string;
  sessionFiles: string[];
};
type PostCompactionSync = (params?: unknown) => Promise<void>;
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  if (!resolve) {
    throw new Error("Expected compaction deferred resolver to be initialized");
  }
  return { promise, resolve };
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  expect(record).toBeDefined();
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function findMockCall(mock: ReturnType<typeof vi.fn>, predicate: (arg: unknown[]) => boolean) {
  const call = mock.mock.calls.find((entry) => predicate(entry));
  if (!call) {
    throw new Error("Expected matching mock call");
  }
  return call;
}

function mockResolvedModel() {
  resolveModelMock.mockReset();
  resolveModelMock.mockReturnValue({
    model: { provider: "openai", api: "responses", id: "fake", input: [] },
    error: null,
    authStorage: { setRuntimeApiKey: vi.fn() },
    modelRegistry: {},
  });
}

function compactionConfig(mode: "await" | "off" | "async") {
  return {
    agents: {
      defaults: {
        compaction: {
          postIndexSync: mode,
        },
      },
    },
  } as never;
}

function wrappedCompactionArgs(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_SESSION_KEY,
    sessionFile: TEST_SESSION_FILE,
    workspaceDir: TEST_WORKSPACE_DIR,
    customInstructions: TEST_CUSTOM_INSTRUCTIONS,
    enqueue: async <T>(task: () => Promise<T> | T) => await task(),
    ...overrides,
  };
}

const sessionHook = (action: string): SessionHookEvent | undefined =>
  triggerInternalHook.mock.calls.find((call) => {
    const event = call[0] as SessionHookEvent | undefined;
    return event?.type === "session" && event.action === action;
  })?.[0] as SessionHookEvent | undefined;

async function runCompactionHooks(params: { sessionKey?: string; messageProvider?: string }) {
  const originalMessages = sessionMessages.slice(1) as AgentMessage[];
  const currentMessages = sessionMessages.slice(1) as AgentMessage[];
  const beforeMetrics = compactTesting.buildBeforeCompactionHookMetrics({
    originalMessages,
    currentMessages,
    estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
  });

  const hookState = await compactTesting.runBeforeCompactionHooks({
    hookRunner,
    sessionId: TEST_SESSION_ID,
    sessionKey: params.sessionKey,
    sessionAgentId: "main",
    workspaceDir: TEST_WORKSPACE_DIR,
    messageProvider: params.messageProvider,
    metrics: beforeMetrics,
  });

  await compactTesting.runAfterCompactionHooks({
    hookRunner,
    sessionId: TEST_SESSION_ID,
    sessionAgentId: "main",
    hookSessionKey: hookState.hookSessionKey,
    missingSessionKey: hookState.missingSessionKey,
    workspaceDir: TEST_WORKSPACE_DIR,
    messageProvider: params.messageProvider,
    messageCountAfter: 1,
    tokensAfter: 10,
    compactedCount: 1,
    sessionFile: TEST_SESSION_FILE,
    summaryLength: "summary".length,
    tokensBefore: 120,
    firstKeptEntryId: "entry-1",
  });
}

beforeAll(async () => {
  const loaded = await loadCompactHooksHarness();
  compactEmbeddedPiSessionDirect = loaded.compactEmbeddedPiSessionDirect;
  compactEmbeddedPiSession = loaded.compactEmbeddedPiSession;
  compactTesting = loaded.__testing;
  onSessionTranscriptUpdate = loaded.onSessionTranscriptUpdate;
});

beforeEach(() => {
  resetCompactHooksHarnessMocks();
});

describe("compactEmbeddedPiSessionDirect hooks", () => {
  beforeEach(() => {
    ensureRuntimePluginsLoaded.mockReset();
    triggerInternalHook.mockClear();
    hookRunner.hasHooks.mockReset();
    hookRunner.runBeforeCompaction.mockReset();
    hookRunner.runAfterCompaction.mockReset();
    mockResolvedModel();
    sessionCompactImpl.mockReset();
    sessionCompactImpl.mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      details: { ok: true },
    });
    resetCompactSessionStateMocks();
  });

  it("bootstraps runtime plugins with the resolved workspace", async () => {
    // This assertion only cares about bootstrap wiring, so stop before the
    // rest of the compaction pipeline can pull in unrelated runtime surfaces.
    resolveModelMock.mockReturnValue({
      model: undefined,
      error: "stop after bootstrap",
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    } as never);

    await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
    });

    expect(ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("forwards gateway subagent binding opt-in during compaction bootstrap", async () => {
    // Coding-tool forwarding is covered elsewhere; this compaction test only
    // owns the runtime bootstrap wiring.
    resolveModelMock.mockReturnValue({
      model: undefined,
      error: "stop after bootstrap",
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    } as never);

    await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });
  });

  it("uses sandboxSessionKey only for compaction sandbox resolution", async () => {
    await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sandboxSessionKey: "agent:main:telegram:default:direct:12345",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
    });

    expect(resolveSandboxContextMock).toHaveBeenCalledWith({
      config: undefined,
      sessionKey: "agent:main:telegram:default:direct:12345",
      workspaceDir: "/tmp/workspace",
    });
  });

  it("routes compaction through shared stream resolution and extra params", () => {
    const resolvedStreamFn = vi.fn();
    resolveEmbeddedAgentStreamFnMock.mockReturnValue(resolvedStreamFn);
    applyExtraParamsToAgentMock.mockReturnValue({
      effectiveExtraParams: { transport: "websocket" },
    });
    const session = {
      agent: {
        streamFn: vi.fn(),
      },
      messages: [{ role: "user", content: "hello" }],
    };

    compactTesting.prepareCompactionSessionAgent({
      session: session as never,
      providerStreamFn: vi.fn(),
      sessionId: "session-1",
      signal: new AbortController().signal,
      effectiveModel: { provider: "openai", id: "fake", api: "responses", input: [] } as never,
      resolvedApiKey: undefined,
      authStorage: { setRuntimeApiKey: vi.fn() },
      config: undefined,
      provider: "openai",
      modelId: "gpt-5.4",
      thinkLevel: "off",
      sessionAgentId: "main",
      effectiveWorkspace: "/tmp/workspace",
      agentDir: "/tmp/workspace",
    });

    const streamArg = mockCallArg(resolveEmbeddedAgentStreamFnMock) as Record<string, unknown>;
    expect(streamArg.currentStreamFn).toBeTypeOf("function");
    expect(streamArg.sessionId).toBe("session-1");
    expect(applyExtraParamsToAgentMock).toHaveBeenCalledWith(
      expectRecordFields(mockCallArg(applyExtraParamsToAgentMock), { streamFn: resolvedStreamFn }),
      undefined,
      "openai",
      "gpt-5.4",
      undefined,
      "off",
      "main",
      "/tmp/workspace",
      expectRecordFields(mockCallArg(applyExtraParamsToAgentMock, 0, 8), {
        provider: "openai",
        id: "fake",
        api: "responses",
      }),
      "/tmp/workspace",
      undefined,
      undefined,
    );
  });

  it("preserves full sender identity when building compaction tools", async () => {
    await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      senderId: "sender-1",
      senderName: "Alice",
      senderUsername: "alice_u",
      senderE164: "+15551234567",
    });

    expectRecordFields(mockCallArg(createOpenClawCodingToolsMock), {
      senderId: "sender-1",
      senderName: "Alice",
      senderUsername: "alice_u",
      senderE164: "+15551234567",
    });
  });

  it("uses the session model fallback chain when overflow compaction fails", async () => {
    resolveModelMock.mockImplementation((provider = "openai", modelId = "fake") => ({
      model: { provider, api: "responses", id: modelId, input: [] },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    }));
    sessionCompactImpl
      .mockRejectedValueOnce(
        Object.assign(new Error("primary compaction rate limited"), {
          status: 429,
          code: "rate_limit_exceeded",
        }),
      )
      .mockResolvedValueOnce({
        summary: "overflow fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });

    const result = await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-primary",
      trigger: "overflow",
      modelFallbacksOverride: ["anthropic/claude-fallback"],
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-primary",
              fallbacks: [],
            },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
    expect(result.result?.summary).toBe("overflow fallback summary");
    const primaryCall = findMockCall(
      resolveModelMock,
      ([provider, modelId]) => provider === "openai" && modelId === "gpt-primary",
    );
    expect(primaryCall[2]).toBeTypeOf("string");
    expect(primaryCall[3]).toBeDefined();
    const fallbackCall = findMockCall(
      resolveModelMock,
      ([provider, modelId]) => provider === "anthropic" && modelId === "claude-fallback",
    );
    expect(fallbackCall[2]).toBeTypeOf("string");
    expect(fallbackCall[3]).toBeDefined();
  });

  it("keeps compaction fallback selection ephemeral", async () => {
    resolveModelMock.mockImplementation((provider = "openai", modelId = "fake") => ({
      model: { provider, api: "responses", id: modelId, input: [] },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    }));
    sessionCompactImpl
      .mockRejectedValueOnce(Object.assign(new Error("400 invalid request body"), { status: 400 }))
      .mockResolvedValueOnce({
        summary: "fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-primary",
            fallbacks: ["anthropic/claude-fallback"],
          },
        },
      },
      sessions: {
        entries: {
          [TEST_SESSION_KEY]: {
            modelProvider: "openai",
            model: "gpt-primary",
          },
        },
      },
    };
    const configBefore = structuredClone(config);

    const result = await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-primary",
      config: config as never,
    });

    expect(result.ok).toBe(true);
    expect(result.result?.summary).toBe("fallback summary");
    const primaryCall = findMockCall(
      resolveModelMock,
      ([provider, modelId]) => provider === "openai" && modelId === "gpt-primary",
    );
    expect(primaryCall[2]).toBeTypeOf("string");
    expect(primaryCall[3]).toBeDefined();
    const fallbackCall = findMockCall(
      resolveModelMock,
      ([provider, modelId]) => provider === "anthropic" && modelId === "claude-fallback",
    );
    expect(fallbackCall[2]).toBeTypeOf("string");
    expect(fallbackCall[3]).toBeDefined();
    expect(config).toEqual(configBefore);
  });

  it("preserves explicit compaction.model behavior without session fallback", async () => {
    resolveModelMock.mockImplementation((provider = "openai", modelId = "fake") => ({
      model: { provider, api: "responses", id: modelId, input: [] },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    }));
    sessionCompactImpl.mockRejectedValueOnce(
      Object.assign(new Error("400 invalid request body"), { status: 400 }),
    );

    const result = await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-primary",
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-primary",
              fallbacks: ["anthropic/claude-fallback"],
            },
            compaction: {
              model: "azure/compact-primary",
            },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(false);
    expect(resolveModelMock).toHaveBeenCalledTimes(1);
    expect(mockCallArg(resolveModelMock)).toBe("azure");
    expect(mockCallArg(resolveModelMock, 0, 1)).toBe("compact-primary");
    expect(mockCallArg(resolveModelMock, 0, 2)).toBeTypeOf("string");
    expect(mockCallArg(resolveModelMock, 0, 3)).toBeDefined();
  });

  it("preserves compaction failure status and code metadata", async () => {
    resolveModelMock.mockImplementation((provider = "openai", modelId = "fake") => ({
      model: { provider, api: "responses", id: modelId, input: [] },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    }));
    sessionCompactImpl.mockRejectedValueOnce(
      Object.assign(new Error("primary compaction rate limited"), {
        status: 429,
        code: "rate_limit_exceeded",
      }),
    );

    const result = await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-primary",
      config: {
        agents: {
          defaults: {
            compaction: {
              model: "openai/gpt-primary",
            },
          },
        },
      } as never,
    });

    expectRecordFields(result, {
      ok: false,
      compacted: false,
    });
    expect(result.failure).toEqual({
      reason: "rate_limit",
      status: 429,
      code: "rate_limit_exceeded",
      rawError: "primary compaction rate limited",
    });
  });

  it("emits internal + plugin compaction hooks with counts", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    await runCompactionHooks({
      sessionKey: TEST_SESSION_KEY,
      messageProvider: "telegram",
    });

    expectRecordFields(sessionHook("compact:before"), {
      type: "session",
      action: "compact:before",
    });
    const beforeContext = sessionHook("compact:before")?.context;
    const afterContext = sessionHook("compact:after")?.context;

    expectRecordFields(beforeContext, {
      messageCount: 2,
      tokenCount: 20,
      messageCountOriginal: 2,
      tokenCountOriginal: 20,
    });
    expectRecordFields(afterContext, {
      messageCount: 1,
      compactedCount: 1,
    });
    expect(afterContext?.compactedCount).toBe(
      (beforeContext?.messageCountOriginal as number) - (afterContext?.messageCount as number),
    );

    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      expectRecordFields(mockCallArg(hookRunner.runBeforeCompaction), {
        messageCount: 2,
        tokenCount: 20,
      }),
      expectRecordFields(mockCallArg(hookRunner.runBeforeCompaction, 0, 1), {
        sessionKey: "agent:main:session-1",
        messageProvider: "telegram",
      }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      {
        messageCount: 1,
        tokenCount: 10,
        compactedCount: 1,
        sessionFile: "/tmp/session.jsonl",
      },
      expectRecordFields(mockCallArg(hookRunner.runAfterCompaction, 0, 1), {
        sessionKey: "agent:main:session-1",
        messageProvider: "telegram",
      }),
    );
  });

  it("uses sessionId as hook session key fallback when sessionKey is missing", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    await runCompactionHooks({});

    expect(sessionHook("compact:before")?.sessionKey).toBe("session-1");
    expect(sessionHook("compact:after")?.sessionKey).toBe("session-1");
    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      mockCallArg(hookRunner.runBeforeCompaction),
      expectRecordFields(mockCallArg(hookRunner.runBeforeCompaction, 0, 1), {
        sessionKey: "session-1",
      }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      mockCallArg(hookRunner.runAfterCompaction),
      expectRecordFields(mockCallArg(hookRunner.runAfterCompaction, 0, 1), {
        sessionKey: "session-1",
      }),
    );
  });

  it("applies validated transcript before hooks even when it becomes empty", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    const beforeMetrics = compactTesting.buildBeforeCompactionHookMetrics({
      originalMessages: [],
      currentMessages: [],
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    });
    await compactTesting.runBeforeCompactionHooks({
      hookRunner,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      workspaceDir: "/tmp",
      metrics: beforeMetrics,
    });

    const beforeContext = sessionHook("compact:before")?.context;
    expectRecordFields(beforeContext, {
      messageCountOriginal: 0,
      tokenCountOriginal: 0,
      messageCount: 0,
      tokenCount: 0,
    });
  });

  it("forwards internal compaction hook messages to the caller", async () => {
    const onHookMessages = vi.fn();
    triggerInternalHook.mockImplementation(async (event: unknown) => {
      const hookEvent = event as { action?: string; messages?: string[] };
      hookEvent.messages?.push(`${hookEvent.action} notice`);
    });
    const beforeMetrics = compactTesting.buildBeforeCompactionHookMetrics({
      originalMessages: sessionMessages.slice(1) as AgentMessage[],
      currentMessages: sessionMessages.slice(1) as AgentMessage[],
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    });

    const hookState = await compactTesting.runBeforeCompactionHooks({
      hookRunner,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      workspaceDir: "/tmp",
      metrics: beforeMetrics,
      onHookMessages,
    });
    await compactTesting.runAfterCompactionHooks({
      hookRunner,
      sessionId: "session-1",
      sessionAgentId: "main",
      hookSessionKey: hookState.hookSessionKey,
      missingSessionKey: hookState.missingSessionKey,
      workspaceDir: "/tmp",
      messageCountAfter: 1,
      tokensAfter: 10,
      compactedCount: 1,
      sessionFile: "/tmp/session.jsonl",
      onHookMessages,
    });

    expect(onHookMessages).toHaveBeenNthCalledWith(1, {
      phase: "before",
      messages: ["compact:before notice"],
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
    expect(onHookMessages).toHaveBeenNthCalledWith(2, {
      phase: "after",
      messages: ["compact:after notice"],
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
  });
  it("emits a transcript update after successful compaction", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);

    try {
      await compactTesting.runPostCompactionSideEffects({
        sessionKey: "agent:main:session-1",
        sessionFile: "  /tmp/session.jsonl  ",
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        sessionFile: "/tmp/session.jsonl",
        sessionKey: "agent:main:session-1",
      });
    } finally {
      cleanup();
    }
  });

  it("emits post-compaction side effects once for a rotated successor transcript", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    rotateTranscriptAfterCompactionMock.mockResolvedValueOnce({
      rotated: true,
      sessionId: "rotated-session",
      sessionFile: "/tmp/rotated-session.jsonl",
      leafId: "rotated-leaf",
    });

    try {
      const result = await compactEmbeddedPiSessionDirect({
        sessionId: "session-1",
        sessionKey: TEST_SESSION_KEY,
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        config: {
          agents: {
            defaults: {
              compaction: {
                truncateAfterCompaction: true,
                postIndexSync: "await",
              },
            },
          },
        } as never,
      });

      expect(result.ok).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        sessionFile: "/tmp/rotated-session.jsonl",
        sessionKey: TEST_SESSION_KEY,
      });
      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledWith({
        reason: "post-compaction",
        sessionFiles: ["/tmp/rotated-session.jsonl"],
      });
    } finally {
      cleanup();
    }
  });

  it("preserves tokensAfter when full-session context exceeds result.tokensBefore", () => {
    estimateTokensMock.mockImplementation((message: unknown) => {
      const role = (message as { role?: string }).role;
      if (role === "user") {
        return 30;
      }
      if (role === "assistant") {
        return 20;
      }
      return 5;
    });
    const tokensAfter = compactTesting.estimateTokensAfterCompaction({
      messagesAfter: [{ role: "user", content: "kept ask" }] as AgentMessage[],
      fullSessionTokensBefore: 55,
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    });

    expect(tokensAfter).toBe(30);
  });

  it("treats pre-compaction token estimation failures as a no-op sanity check", () => {
    estimateTokensMock.mockImplementation((message: unknown) => {
      const role = (message as { role?: string }).role;
      if (role === "assistant") {
        throw new Error("legacy message");
      }
      if (role === "user") {
        return 30;
      }
      return 5;
    });
    const beforeMetrics = compactTesting.buildBeforeCompactionHookMetrics({
      originalMessages: sessionMessages as AgentMessage[],
      currentMessages: sessionMessages as AgentMessage[],
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    });
    const tokensAfter = compactTesting.estimateTokensAfterCompaction({
      messagesAfter: [{ role: "user", content: "kept ask" }] as AgentMessage[],
      fullSessionTokensBefore: 0,
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    });

    expect(beforeMetrics.tokenCountOriginal).toBeUndefined();
    expect(beforeMetrics.tokenCountBefore).toBeUndefined();
    expect(tokensAfter).toBe(30);
  });

  it("skips sync in await mode when postCompactionForce is false", async () => {
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    resolveMemorySearchConfigMock.mockReturnValue({
      sources: ["sessions"],
      sync: {
        sessions: {
          postCompactionForce: false,
        },
      },
    });

    await compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("await"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    const resolveAgentArg = mockCallArg(resolveSessionAgentIdMock) as Record<string, unknown>;
    expectRecordFields(resolveAgentArg, { sessionKey: TEST_SESSION_KEY });
    expect(resolveAgentArg.config).toBeTypeOf("object");
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("awaits post-compaction memory sync in await mode when postCompactionForce is true", async () => {
    const syncStarted = createDeferred<PostCompactionSyncParams>();
    const syncRelease = createDeferred<void>();
    const sync = vi.fn<PostCompactionSync>(async (params) => {
      syncStarted.resolve(params as PostCompactionSyncParams);
      await syncRelease.promise;
    });
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    let settled = false;

    const resultPromise = compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("await"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    void resultPromise.then(() => {
      settled = true;
    });
    await expect(syncStarted.promise).resolves.toEqual({
      reason: "post-compaction",
      sessionFiles: [TEST_SESSION_FILE],
    });
    expect(settled).toBe(false);
    syncRelease.resolve(undefined);
    await resultPromise;
    expect(settled).toBe(true);
  });

  it("skips post-compaction memory sync when the mode is off", async () => {
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });

    await compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("off"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    expect(resolveSessionAgentIdMock).not.toHaveBeenCalled();
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("fires post-compaction memory sync without awaiting it in async mode", async () => {
    const sync = vi.fn<PostCompactionSync>(async () => {});
    const managerRequested = createDeferred<void>();
    const managerGate = createDeferred<{ manager: { sync: PostCompactionSync } }>();
    const syncStarted = createDeferred<PostCompactionSyncParams>();
    sync.mockImplementation(async (params) => {
      syncStarted.resolve(params as PostCompactionSyncParams);
    });
    getMemorySearchManagerMock.mockImplementation(async () => {
      managerRequested.resolve(undefined);
      return await managerGate.promise;
    });
    let settled = false;

    const resultPromise = compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("async"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    await managerRequested.promise;
    void resultPromise.then(() => {
      settled = true;
    });
    await resultPromise;
    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    managerGate.resolve({ manager: { sync } });
    await expect(syncStarted.promise).resolves.toEqual({
      reason: "post-compaction",
      sessionFiles: [TEST_SESSION_FILE],
    });
  });

  it("skips compaction when the transcript only contains boilerplate replies and tool output", () => {
    const messages = [
      { role: "user", content: "<b>HEARTBEAT_OK</b>", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "exec",
        content: [{ type: "text", text: "checked" }],
        isError: false,
        timestamp: 2,
      },
    ] as AgentMessage[];

    expect(compactTesting.containsRealConversationMessages(messages)).toBe(false);
  });

  it("skips compaction when the transcript only contains heartbeat boilerplate and reasoning blocks", () => {
    const messages = [
      { role: "user", content: "<b>HEARTBEAT_OK</b>", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "checking" }],
        timestamp: 2,
      },
    ] as AgentMessage[];

    expect(compactTesting.containsRealConversationMessages(messages)).toBe(false);
  });

  it("does not treat assistant-only tool-call blocks as meaningful conversation", () => {
    expect(
      compactTesting.hasMeaningfulConversationContent({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      } as AgentMessage),
    ).toBe(false);
  });

  it("counts tool output as real only when a meaningful user ask exists in the lookback window", () => {
    const heartbeatToolResultWindow = [
      { role: "user", content: "<b>HEARTBEAT_OK</b>" },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "exec",
        content: [{ type: "text", text: "checked" }],
      },
    ] as AgentMessage[];
    expect(
      compactTesting.hasRealConversationContent(
        heartbeatToolResultWindow[1],
        heartbeatToolResultWindow,
        1,
      ),
    ).toBe(false);

    const realAskToolResultWindow = [
      { role: "assistant", content: "NO_REPLY" },
      { role: "user", content: "please inspect the failing PR" },
      {
        role: "toolResult",
        toolCallId: "t2",
        toolName: "exec",
        content: [{ type: "text", text: "checked" }],
      },
    ] as AgentMessage[];
    expect(
      compactTesting.hasRealConversationContent(
        realAskToolResultWindow[2],
        realAskToolResultWindow,
        2,
      ),
    ).toBe(true);
  });

  it("counts visible custom prompts as real conversation anchors for tool output", () => {
    const messages = [
      {
        role: "custom",
        customType: "cron-request",
        content: "prepare the daily report",
        display: true,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "report source data" }],
      },
    ] as AgentMessage[];

    expect(compactTesting.hasRealConversationContent(messages[0], messages, 0)).toBe(true);
    expect(compactTesting.hasRealConversationContent(messages[2], messages, 2)).toBe(true);
  });

  it("registers the Ollama api provider before compaction", () => {
    const streamFn = vi.fn();
    registerProviderStreamForModelMock.mockReturnValue(streamFn);

    const result = compactTesting.resolveCompactionProviderStream({
      effectiveModel: {
        provider: "ollama",
        api: "ollama",
        id: "qwen3:8b",
        input: ["text"],
        baseUrl: "http://127.0.0.1:11434",
        headers: { Authorization: "Bearer ollama-cloud" },
      } as never,
      config: undefined,
      agentDir: "/tmp",
      effectiveWorkspace: "/tmp",
    });

    expect(result).toBe(streamFn);
    const streamRegistration = mockCallArg(registerProviderStreamForModelMock) as Record<
      string,
      unknown
    >;
    expectRecordFields(streamRegistration, {
      agentDir: "/tmp",
      workspaceDir: "/tmp",
    });
    expectRecordFields(streamRegistration.model, {
      provider: "ollama",
      api: "ollama",
      id: "qwen3:8b",
    });
  });

  it("aborts in-flight compaction when the caller abort signal fires", async () => {
    const { compactWithSafetyTimeout } = await vi.importActual<
      typeof import("./compaction-safety-timeout.js")
    >("./compaction-safety-timeout.js");
    const controller = new AbortController();
    const compactStarted = createDeferred<void>();

    const resultPromise = compactWithSafetyTimeout(
      async () => {
        compactStarted.resolve(undefined);
        return await new Promise<never>(() => {});
      },
      30_000,
      {
        abortSignal: controller.signal,
        onCancel: () => {
          sessionAbortCompactionMock();
        },
      },
    );

    await compactStarted.promise;
    controller.abort(new Error("request timed out"));

    await expect(resultPromise).rejects.toThrow("request timed out");
    expect(sessionAbortCompactionMock).toHaveBeenCalledTimes(1);
  });
});

describe("compactEmbeddedPiSession hooks (ownsCompaction engine)", () => {
  beforeEach(() => {
    hookRunner.hasHooks.mockReset();
    hookRunner.runBeforeCompaction.mockReset();
    hookRunner.runAfterCompaction.mockReset();
    resolveContextEngineMock.mockReset();
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: true },
      compact: contextEngineCompactMock,
    });
    contextEngineCompactMock.mockReset();
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: { summary: "engine-summary", tokensAfter: 50 },
    });
    mockResolvedModel();
  });

  it("binds context-engine compaction runtime LLM to the session agent", async () => {
    resolveSessionAgentIdsMock.mockReturnValueOnce({
      defaultAgentId: "main",
      sessionAgentId: "lossless-agent",
    });

    await compactEmbeddedPiSession(
      wrappedCompactionArgs({
        config: {
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
            },
          },
        },
        sessionKey: "legacy-topic-47",
      }),
    );

    const contextEngineCompactCalls = contextEngineCompactMock.mock.calls as unknown as Array<
      [
        {
          runtimeContext?: {
            llm?: {
              complete?: (params: {
                messages: Array<{ role: "user"; content: string }>;
                agentId?: string;
              }) => Promise<unknown>;
            };
          };
        },
      ]
    >;
    const runtimeContext = contextEngineCompactCalls[0]?.[0]?.runtimeContext;
    if (!runtimeContext) {
      throw new Error("expected compaction runtime context");
    }
    expect(runtimeContext.llm?.complete).toBeTypeOf("function");

    await expect(
      runtimeContext.llm?.complete?.({
        messages: [{ role: "user", content: "summarize" }],
        agentId: "other-agent",
      }),
    ).rejects.toThrow("cannot override the active session agent");
  });

  it("fires before_compaction with sentinel -1 and after_compaction on success", async () => {
    hookRunner.hasHooks.mockReturnValue(true);

    const result = await compactEmbeddedPiSession(
      wrappedCompactionArgs({
        messageChannel: "telegram",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);

    expect(mockCallArg(hookRunner.runBeforeCompaction)).toEqual({
      messageCount: -1,
      sessionFile: TEST_SESSION_FILE,
    });
    expectRecordFields(mockCallArg(hookRunner.runBeforeCompaction, 0, 1), {
      sessionKey: TEST_SESSION_KEY,
      messageProvider: "telegram",
    });
    expect(mockCallArg(hookRunner.runAfterCompaction)).toEqual({
      messageCount: -1,
      compactedCount: -1,
      tokenCount: 50,
      sessionFile: TEST_SESSION_FILE,
    });
    expectRecordFields(mockCallArg(hookRunner.runAfterCompaction, 0, 1), {
      sessionKey: TEST_SESSION_KEY,
      messageProvider: "telegram",
    });
  });

  it("passes the rotated session id to engine-owned after_compaction hooks", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    const rotatedSessionId = "rotated-session";
    const rotatedSessionFile = "/tmp/rotated-session.jsonl";
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: {
        summary: "engine-summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 50,
        sessionId: rotatedSessionId,
        sessionFile: rotatedSessionFile,
      },
    } as never);

    const result = await compactEmbeddedPiSession(wrappedCompactionArgs());

    expect(result.ok).toBe(true);
    expectRecordFields(mockCallArg(hookRunner.runAfterCompaction), {
      sessionFile: rotatedSessionFile,
    });
    expectRecordFields(mockCallArg(hookRunner.runAfterCompaction, 0, 1), {
      sessionId: rotatedSessionId,
      sessionKey: TEST_SESSION_KEY,
    });
  });

  it("emits a transcript update and post-compaction memory sync on the engine-owned path", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });

    try {
      const result = await compactEmbeddedPiSession(
        wrappedCompactionArgs({
          sessionFile: `  ${TEST_SESSION_FILE}  `,
          config: compactionConfig("await"),
        }),
      );

      expect(result.ok).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        sessionFile: TEST_SESSION_FILE,
        sessionKey: TEST_SESSION_KEY,
      });
      expect(sync).toHaveBeenCalledWith({
        reason: "post-compaction",
        sessionFiles: [TEST_SESSION_FILE],
      });
    } finally {
      cleanup();
    }
  });

  it("runs maintain after successful compaction with a transcript rewrite helper", async () => {
    const maintain = vi.fn(async (_params?: unknown) => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: true },
      compact: contextEngineCompactMock,
      maintain,
    } as never);

    const result = await compactEmbeddedPiSession(wrappedCompactionArgs());

    expect(result.ok).toBe(true);
    const runtimeContext = (
      maintain.mock.calls[0]?.[0] as { runtimeContext?: Record<string, unknown> } | undefined
    )?.runtimeContext;
    expectRecordFields(mockCallArg(maintain), {
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });
    expect(runtimeContext?.workspaceDir).toBe(TEST_WORKSPACE_DIR);
    expect(runtimeContext?.rewriteTranscriptEntries).toBeTypeOf("function");
  });

  it("resolves the effective compaction model before manual engine-owned compaction", async () => {
    await compactEmbeddedPiSession(
      wrappedCompactionArgs({
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "anthropic/claude-opus-4-6",
              },
            },
          },
        },
        provider: "openai-codex",
        model: "gpt-5.4",
        authProfileId: "openai:p1",
      }),
    );

    expect(mockCallArg(resolveModelMock)).toBe("anthropic");
    expect(mockCallArg(resolveModelMock, 0, 1)).toBe("claude-opus-4-6");
    expect(mockCallArg(resolveModelMock, 0, 2)).toBeTypeOf("string");
    expect(mockCallArg(resolveModelMock, 0, 3)).toBeDefined();
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      provider: "anthropic",
      model: "claude-opus-4-6",
      authProfileId: undefined,
    });
  });

  it("passes resolved context-engine runtime context to harness compaction", async () => {
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "harness",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
    });

    const result = await compactEmbeddedPiSession(
      wrappedCompactionArgs({
        provider: "openai-codex",
        model: "gpt-5.4",
        authProfileId: "openai:p1",
        currentTokenCount: 333,
      }),
    );

    expect(result.ok).toBe(true);
    const harnessArg = mockCallArg(maybeCompactAgentHarnessSessionMock) as Record<string, unknown>;
    expect(harnessArg.contextEngine).toBeDefined();
    expect(harnessArg.contextTokenBudget).toBeTypeOf("number");
    expectRecordFields(harnessArg.contextEngineRuntimeContext, {
      sessionKey: TEST_SESSION_KEY,
      workspaceDir: TEST_WORKSPACE_DIR,
      provider: "openai-codex",
      model: "gpt-5.4",
      authProfileId: "openai:p1",
      currentTokenCount: 333,
    });
  });

  it("does not fire after_compaction when compaction fails", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    contextEngineCompactMock.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
      result: undefined,
    });

    const result = await compactEmbeddedPiSession(wrappedCompactionArgs());

    expect(result.ok).toBe(false);
    expect(hookRunner.runBeforeCompaction).toHaveBeenCalled();
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("does not duplicate transcript updates or sync in the wrapper when the engine delegates compaction", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
    });

    try {
      const result = await compactEmbeddedPiSession(
        wrappedCompactionArgs({
          config: compactionConfig("await"),
        }),
      );

      expect(result.ok).toBe(true);
      expect(listener).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("reuses a delegated compaction successor transcript", async () => {
    const maintain = vi.fn(async (_params?: unknown) => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    const delegatedSessionId = "delegated-session";
    const delegatedSessionFile = "/tmp/delegated-session.jsonl";
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
      maintain,
    } as never);
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: {
        summary: "engine-summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 50,
        sessionId: delegatedSessionId,
        sessionFile: delegatedSessionFile,
      },
    } as never);

    const result = await compactEmbeddedPiSession(
      wrappedCompactionArgs({
        config: {
          agents: {
            defaults: {
              compaction: {
                truncateAfterCompaction: true,
              },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.result?.sessionId).toBe(delegatedSessionId);
    expect(result.result?.sessionFile).toBe(delegatedSessionFile);
    expectRecordFields(mockCallArg(maintain), {
      sessionId: delegatedSessionId,
      sessionFile: delegatedSessionFile,
    });
  });

  it("keeps a delegated result that echoes the current transcript on the active transcript", async () => {
    const maintain = vi.fn(async (_params?: unknown) => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
      maintain,
    } as never);
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: {
        summary: "engine-summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 50,
        sessionId: TEST_SESSION_ID,
        sessionFile: TEST_SESSION_FILE,
      },
    } as never);
    const result = await compactEmbeddedPiSession(
      wrappedCompactionArgs({
        config: {
          agents: {
            defaults: {
              compaction: {
                truncateAfterCompaction: true,
              },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(rotateTranscriptAfterCompactionMock).not.toHaveBeenCalled();
    expect(result.result?.sessionId).toBeUndefined();
    expect(result.result?.sessionFile).toBeUndefined();
    expectRecordFields(mockCallArg(maintain), {
      sessionId: TEST_SESSION_ID,
      sessionFile: TEST_SESSION_FILE,
    });
  });

  it("catches and logs hook exceptions without aborting compaction", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeCompaction.mockRejectedValue(new Error("hook boom"));

    const result = await compactEmbeddedPiSession(wrappedCompactionArgs());

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(contextEngineCompactMock).toHaveBeenCalled();
  });
});
