import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../context-engine/types.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

const {
  executePreparedCliRunMock,
  loadCliSessionContextEngineMessagesMock,
  loadCliSessionHistoryMessagesMock,
  getGlobalHookRunnerMock,
} = vi.hoisted(() => ({
  executePreparedCliRunMock: vi.fn(),
  loadCliSessionContextEngineMessagesMock: vi.fn(),
  loadCliSessionHistoryMessagesMock: vi.fn(),
  getGlobalHookRunnerMock: vi.fn(() => null),
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

vi.mock("./cli-runner/session-history.js", () => ({
  loadCliSessionContextEngineMessages: loadCliSessionContextEngineMessagesMock,
  loadCliSessionHistoryMessages: loadCliSessionHistoryMessagesMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

function textMessage(role: "user" | "assistant", text: string, timestamp: number): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
  return {
    info: { id: "test-context-engine", name: "Test context engine" },
    ingest: vi.fn(async () => ({ ingested: true })),
    assemble: vi.fn(async (params) => ({
      messages: params.messages,
      estimatedTokens: 0,
    })),
    compact: vi.fn(async () => ({ ok: true, compacted: false })),
    ...overrides,
  };
}

function createMaintenanceResult() {
  return {
    changed: false,
    bytesFreed: 0,
    rewrittenEntries: 0,
  };
}

function buildPreparedContext(contextEngine: ContextEngine): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: ["--print"],
    output: "text" as const,
    input: "arg" as const,
    sessionMode: "existing" as const,
    serialize: true,
  };

  return {
    params: {
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      agentId: "main",
      sessionFile: "session.jsonl",
      workspaceDir: "/tmp/openclaw-cli-context-engine-test",
      prompt: "visible ask",
      transcriptPrompt: "transcript visible ask",
      provider: "claude-cli",
      model: "sonnet-4.6",
      thinkLevel: "low",
      timeoutMs: 1_000,
      runId: "run-1",
    },
    started: Date.now(),
    workspaceDir: "/tmp/openclaw-cli-context-engine-test",
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: false,
      pluginId: "anthropic",
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: {
      sessionId: "existing-external-cli-session",
    },
    hadSessionFile: true,
    contextEngineConfig: {},
    contextEngine,
    contextEngineTurnPrompt: "transcript visible ask",
    modelId: "sonnet-4.6",
    normalizedModel: "sonnet-4.6",
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

function expectMessageText(message: AgentMessage | undefined, expected: string): void {
  expect(message).toBeDefined();
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    expect(content).toBe(expected);
    return;
  }
  expect(Array.isArray(content)).toBe(true);
  expect((content as unknown[] | undefined)?.[0]).toMatchObject({ type: "text", text: expected });
}

describe("runPreparedCliAgent context engine lifecycle", () => {
  beforeEach(() => {
    executePreparedCliRunMock.mockReset();
    executePreparedCliRunMock.mockResolvedValue({
      text: " final answer ",
      rawText: " final answer ",
      sessionId: "external-cli-session-1",
      usage: { input: 11, output: 7, total: 18 },
      finalPromptText: "prompt sent to cli",
    });
    loadCliSessionContextEngineMessagesMock.mockReset();
    loadCliSessionContextEngineMessagesMock.mockResolvedValue([
      textMessage("user", "old ask", 1),
      textMessage("assistant", "old answer", 2),
    ]);
    loadCliSessionHistoryMessagesMock.mockReset();
    loadCliSessionHistoryMessagesMock.mockResolvedValue([]);
    getGlobalHookRunnerMock.mockReset();
    getGlobalHookRunnerMock.mockReturnValue(null);
  });

  it("finalizes successful CLI turns with the active context engine", async () => {
    const bootstrap = vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => ({
      bootstrapped: true,
    }));
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ bootstrap, afterTurn, maintain, dispose });
    const context = buildPreparedContext(contextEngine);
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    const result = await runPreparedCliAgent(context);

    expect(result.meta.agentMeta?.sessionId).toBe("external-cli-session-1");
    expect(loadCliSessionContextEngineMessagesMock).toHaveBeenCalledWith({
      sessionId: "openclaw-session-1",
      sessionFile: "session.jsonl",
      sessionKey: "agent:main:main",
      agentId: "main",
      config: undefined,
    });
    expect(loadCliSessionHistoryMessagesMock).not.toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalledWith({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      sessionFile: "session.jsonl",
    });
    expect(afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect(afterTurnParams).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      sessionFile: "session.jsonl",
      prePromptMessageCount: 2,
      tokenBudget: undefined,
      runtimeContext: undefined,
    });
    expect(afterTurnParams?.messages).toHaveLength(4);
    expect(afterTurnParams?.messages.slice(0, 2)).toEqual([
      textMessage("user", "old ask", 1),
      textMessage("assistant", "old answer", 2),
    ]);
    expectMessageText(afterTurnParams?.messages[2], "transcript visible ask");
    expectMessageText(afterTurnParams?.messages[3], "final answer");
    expect(afterTurnParams?.messages[3]).toMatchObject({
      role: "assistant",
      provider: "claude-cli",
      model: "sonnet-4.6",
      usage: { input: 11, output: 7, total: 18 },
    });
    expect(maintain).toHaveBeenCalledTimes(2);
    expect(maintain.mock.calls[1]?.[0]).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      sessionFile: "session.jsonl",
      runtimeContext: {
        rewriteTranscriptEntries: expect.any(Function),
        llm: { complete: expect.any(Function) },
      },
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not synthesize a context-engine user turn for empty transcript prompts", async () => {
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ afterTurn, dispose });
    const context = buildPreparedContext(contextEngine);
    context.params.transcriptPrompt = "";
    context.contextEngineTurnPrompt = "";
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    await runPreparedCliAgent(context);

    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect(afterTurnParams?.messages).toHaveLength(3);
    expect(afterTurnParams?.prePromptMessageCount).toBe(2);
    expect(afterTurnParams?.messages.slice(0, 2)).toEqual([
      textMessage("user", "old ask", 1),
      textMessage("assistant", "old answer", 2),
    ]);
    const turnMessages = afterTurnParams?.messages.slice(afterTurnParams.prePromptMessageCount);
    expect(turnMessages).toHaveLength(1);
    expectMessageText(turnMessages?.[0], "final answer");
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not finalize prepared model prompt as transcript turn text", async () => {
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ afterTurn, dispose });
    const context = buildPreparedContext(contextEngine);
    context.params.prompt = "runtime context\n\noriginal user ask";
    delete context.params.transcriptPrompt;
    context.contextEngineTurnPrompt = "original user ask";
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    await runPreparedCliAgent(context);

    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect(afterTurnParams?.messages).toHaveLength(4);
    expect(afterTurnParams?.prePromptMessageCount).toBe(2);
    const turnMessages = afterTurnParams?.messages.slice(afterTurnParams.prePromptMessageCount);
    expect(turnMessages).toHaveLength(2);
    expectMessageText(turnMessages?.[0], "original user ask");
    expectMessageText(turnMessages?.[1], "final answer");
    expect(dispose).not.toHaveBeenCalled();
  });

  it("loads unbounded context-engine history separately from hook history", async () => {
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ afterTurn, dispose });
    const context = buildPreparedContext(contextEngine);
    const fullHistory = Array.from({ length: 101 }, (_, index) =>
      textMessage("user", `old ask ${index}`, index),
    );
    loadCliSessionContextEngineMessagesMock.mockResolvedValueOnce(fullHistory);
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    await runPreparedCliAgent(context);

    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect(loadCliSessionContextEngineMessagesMock).toHaveBeenCalledTimes(1);
    expect(loadCliSessionHistoryMessagesMock).not.toHaveBeenCalled();
    expect(afterTurnParams?.prePromptMessageCount).toBe(101);
    expect(afterTurnParams?.messages.slice(0, 101)).toEqual(fullHistory);
  });

  it("loads context-engine history after bootstrap lifecycle runs", async () => {
    const postBootstrapHistory = [textMessage("user", "post-bootstrap history", 9)];
    const bootstrap = vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => {
      loadCliSessionContextEngineMessagesMock.mockResolvedValueOnce(postBootstrapHistory);
      return { bootstrapped: true };
    });
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ bootstrap, afterTurn, dispose });
    const context = buildPreparedContext(contextEngine);
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    await runPreparedCliAgent(context);

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(loadCliSessionContextEngineMessagesMock).toHaveBeenCalledTimes(1);
    const bootstrapOrder = bootstrap.mock.invocationCallOrder[0];
    const loadHistoryOrder = loadCliSessionContextEngineMessagesMock.mock.invocationCallOrder[0];
    if (typeof bootstrapOrder !== "number" || typeof loadHistoryOrder !== "number") {
      throw new Error("Expected bootstrap and history load invocation order");
    }
    expect(bootstrapOrder).toBeLessThan(loadHistoryOrder);
    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect(afterTurnParams?.prePromptMessageCount).toBe(1);
    expect(afterTurnParams?.messages[0]).toEqual(postBootstrapHistory[0]);
  });

  it("falls back to ingestBatch and still runs turn maintenance", async () => {
    const ingestBatch = vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async () => ({
      ingestedCount: 2,
    }));
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ ingestBatch, maintain, dispose });
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    await runPreparedCliAgent(buildPreparedContext(contextEngine));

    expect(ingestBatch).toHaveBeenCalledTimes(1);
    const ingestBatchParams = ingestBatch.mock.calls[0]?.[0];
    expect(ingestBatchParams).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
    });
    expect(ingestBatchParams?.messages).toHaveLength(2);
    expectMessageText(ingestBatchParams?.messages[0], "transcript visible ask");
    expectMessageText(ingestBatchParams?.messages[1], "final answer");
    expect(maintain).toHaveBeenCalledTimes(2);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("preserves deferred maintenance ownership for background engines", async () => {
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({
      info: {
        id: "test-background-context-engine",
        name: "Test background context engine",
        turnMaintenanceMode: "background",
      },
      maintain,
      dispose,
    });
    const { runPreparedCliAgent } = await import("./cli-runner.js");
    const context = buildPreparedContext(contextEngine);

    await runPreparedCliAgent(context);

    expect(dispose).not.toHaveBeenCalled();
    expect(context.contextEngineDeferredTurnMaintenance).toBeDefined();
    await context.contextEngineDeferredTurnMaintenance;
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not dispose background engines when no deferred turn maintenance is queued", async () => {
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({
      info: {
        id: "test-background-context-engine",
        name: "Test background context engine",
        turnMaintenanceMode: "background",
      },
      dispose,
    });
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    await runPreparedCliAgent(buildPreparedContext(contextEngine));

    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not dispose background engines after failed CLI attempts", async () => {
    executePreparedCliRunMock.mockRejectedValue(new Error("cli boom"));
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({
      info: {
        id: "test-background-context-engine",
        name: "Test background context engine",
        turnMaintenanceMode: "background",
      },
      maintain,
      dispose,
    });
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    await expect(runPreparedCliAgent(buildPreparedContext(contextEngine))).rejects.toThrow(
      "cli boom",
    );

    expect(maintain).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not finalize or run turn maintenance on failed CLI attempts", async () => {
    executePreparedCliRunMock.mockRejectedValue(new Error("cli boom"));
    const bootstrap = vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => ({
      bootstrapped: true,
    }));
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const ingestBatch = vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async () => ({
      ingestedCount: 0,
    }));
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({
      bootstrap,
      afterTurn,
      ingestBatch,
      maintain,
      dispose,
    });
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    await expect(runPreparedCliAgent(buildPreparedContext(contextEngine))).rejects.toThrow(
      "cli boom",
    );

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(afterTurn).not.toHaveBeenCalled();
    expect(ingestBatch).not.toHaveBeenCalled();
    expect(maintain).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not dispose context engines when CLI attempts fail", async () => {
    executePreparedCliRunMock.mockRejectedValue(new Error("cli boom"));
    const dispose = vi.fn(async () => {
      throw new Error("dispose boom");
    });
    const contextEngine = createContextEngine({ dispose });
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    await expect(runPreparedCliAgent(buildPreparedContext(contextEngine))).rejects.toThrow(
      "cli boom",
    );

    expect(dispose).not.toHaveBeenCalled();
  });
});
