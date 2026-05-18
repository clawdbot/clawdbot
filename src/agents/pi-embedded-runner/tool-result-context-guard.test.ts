import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { MidTurnPrecheckSignal } from "./run/midturn-precheck.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  formatContextLimitTruncationNotice,
  installContextEngineLoopHook,
  installToolResultContextGuard,
  PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
} from "./tool-result-context-guard.js";

function makeUser(text: string): AgentMessage {
  return castAgentMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

function makeToolResult(id: string, text: string, toolName = "grep"): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  });
}

function makeAssistant(text: string, extras: Record<string, unknown> = {}): AgentMessage {
  return castAgentMessage({
    role: "assistant",
    content: text,
    timestamp: Date.now(),
    ...extras,
  });
}

function makeReadToolResult(id: string, text: string): AgentMessage {
  return makeToolResult(id, text, "read");
}

function makeLegacyToolResult(id: string, text: string): AgentMessage {
  return castAgentMessage({
    role: "tool",
    tool_call_id: id,
    tool_name: "read",
    content: text,
  });
}

function makeToolResultWithDetails(id: string, text: string, detailText: string): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    details: {
      truncation: {
        truncated: true,
        outputLines: 100,
        content: detailText,
      },
    },
    isError: false,
    timestamp: Date.now(),
  });
}

function getToolResultText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const block = content.find(
    (entry) => entry && typeof entry === "object" && (entry as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

function makeGuardableAgent(
  transformContext?: (
    messages: AgentMessage[],
    signal: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>,
) {
  return { transformContext };
}

async function applyGuardToContext(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  contextForNextCall: AgentMessage[],
  contextWindowTokens = 1_000,
) {
  installToolResultContextGuard({
    agent,
    contextWindowTokens,
  });
  return await agent.transformContext?.(contextForNextCall, new AbortController().signal);
}

async function applyMidTurnPrecheckGuardToContext(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  contextForNextCall: AgentMessage[],
  options: {
    contextWindowTokens?: number;
    contextTokenBudget?: number;
    reserveTokens?: number;
    toolResultMaxChars?: number;
    prePromptMessageCount?: number;
    systemPrompt?: string;
  } = {},
) {
  const contextWindowTokens = options.contextWindowTokens ?? options.contextTokenBudget ?? 20_000;
  installToolResultContextGuard({
    agent,
    contextWindowTokens,
    midTurnPrecheck: {
      enabled: true,
      contextTokenBudget: options.contextTokenBudget ?? contextWindowTokens,
      reserveTokens: () => options.reserveTokens ?? 10_000,
      toolResultMaxChars: options.toolResultMaxChars,
      getSystemPrompt: () => options.systemPrompt,
      ...(options.prePromptMessageCount !== undefined
        ? { getPrePromptMessageCount: () => options.prePromptMessageCount as number }
        : {}),
    },
  });
  return await agent.transformContext?.(contextForNextCall, new AbortController().signal);
}

function expectPiStyleTruncation(text: string): void {
  expect(text).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  expect(text).toMatch(/\[\.\.\. \d+ more characters truncated\]$/);
  expect(text).not.toContain("[compacted: tool output removed to free context]");
  expect(text).not.toContain("[compacted: tool output trimmed to free context]");
  expect(text).not.toContain("[truncated: output exceeded context limit]");
}

function mockCallArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
  argIndex = 0,
): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex + 1}`);
  }
  return call[argIndex];
}

function recordMockArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const arg = mockCallArg(mock, callIndex, argIndex);
  if (!arg || typeof arg !== "object") {
    throw new Error("expected mock argument record");
  }
  return arg as Record<string, unknown>;
}

describe("formatContextLimitTruncationNotice", () => {
  it("formats pi-style truncation wording with a count", () => {
    expect(formatContextLimitTruncationNotice(123)).toBe("[... 123 more characters truncated]");
  });
});

describe("installToolResultContextGuard", () => {
  it("passes through unchanged context when under the per-tool and total budget", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeUser("hello"), makeToolResult("call_ok", "small output")];

    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).toBe(contextForNextCall);
  });

  it("does not preemptively overflow large non-tool context that is still under the high-water mark", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeUser("u".repeat(3_200))];

    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).toBe(contextForNextCall);
  });

  it("returns a cloned guarded context so original oversized tool output stays visible", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeToolResult("call_big", "z".repeat(5_000))];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];

    expect(transformed).not.toBe(contextForNextCall);
    const newResultText = getToolResultText(transformed[0]);
    expect(newResultText.length).toBeLessThan(5_000);
    expectPiStyleTruncation(newResultText);
    expect(getToolResultText(contextForNextCall[0])).toBe("z".repeat(5_000));
  });

  it("wraps an existing transformContext and guards the transformed output", async () => {
    const agent = makeGuardableAgent((messages) =>
      messages.map((msg) =>
        castAgentMessage({
          ...(msg as unknown as Record<string, unknown>),
        }),
      ),
    );
    const contextForNextCall = [makeToolResult("call_big", "x".repeat(5_000))];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];

    expect(transformed).not.toBe(contextForNextCall);
    expectPiStyleTruncation(getToolResultText(transformed[0]));
  });

  it("handles legacy role=tool string outputs with pi-style truncation wording", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeLegacyToolResult("call_big", "y".repeat(5_000))];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];
    const newResultText = getToolResultText(transformed[0]);

    expect(typeof (transformed[0] as { content?: unknown }).content).toBe("string");
    expectPiStyleTruncation(newResultText);
  });

  it("drops oversized tool-result details when truncating once", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeToolResultWithDetails("call_big", "x".repeat(900), "d".repeat(8_000)),
    ];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];
    const result = transformed[0] as { details?: unknown };
    const newResultText = getToolResultText(transformed[0]);

    expectPiStyleTruncation(newResultText);
    expect(result.details).toBeUndefined();
    const originalDetails = (contextForNextCall[0] as { details?: { truncation?: unknown } })
      .details;
    expect(originalDetails?.truncation).toEqual({
      truncated: true,
      outputLines: 100,
      content: "d".repeat(8_000),
    });
  });

  it("throws a preemptive overflow when total context still exceeds the high-water mark", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(50_000)),
      makeToolResult("call_big", "x".repeat(5_000)),
    ];

    await expect(applyGuardToContext(agent, contextForNextCall)).rejects.toThrow(
      PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
    );
    expect(getToolResultText(contextForNextCall[1])).toBe("x".repeat(5_000));
  });

  it("throws instead of rewriting older tool results under aggregate pressure", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(50_000)),
      makeToolResult("call_1", "a".repeat(500)),
      makeToolResult("call_2", "b".repeat(500)),
      makeToolResult("call_3", "c".repeat(500)),
    ];

    await expect(applyGuardToContext(agent, contextForNextCall)).rejects.toThrow(
      PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
    );
    expect(getToolResultText(contextForNextCall[1])).toBe("a".repeat(500));
    expect(getToolResultText(contextForNextCall[2])).toBe("b".repeat(500));
    expect(getToolResultText(contextForNextCall[3])).toBe("c".repeat(500));
  });

  it("does not special-case the latest read result before throwing under aggregate pressure", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(50_000)),
      makeToolResult("call_old", "x".repeat(400)),
      makeReadToolResult("call_new", "y".repeat(500)),
    ];

    await expect(applyGuardToContext(agent, contextForNextCall)).rejects.toThrow(
      PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
    );
    expect(getToolResultText(contextForNextCall[1])).toBe("x".repeat(400));
    expect(getToolResultText(contextForNextCall[2])).toBe("y".repeat(500));
  });

  it("supports model-window-specific truncation for large but otherwise valid tool results", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeToolResult("call_big", "q".repeat(95_000))];

    const transformed = (await applyGuardToContext(
      agent,
      contextForNextCall,
      100_000,
    )) as AgentMessage[];

    expectPiStyleTruncation(getToolResultText(transformed[0]));
  });

  it("raises a structured mid-turn precheck signal after a new tool result overflows", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("prompt already in history"),
      makeToolResult("call_big", "x".repeat(80_000)),
    ];

    try {
      await applyMidTurnPrecheckGuardToContext(agent, contextForNextCall, {
        contextWindowTokens: 200_000,
        contextTokenBudget: 20_000,
        reserveTokens: 12_000,
        toolResultMaxChars: 16_000,
        prePromptMessageCount: 1,
      });
      throw new Error("expected mid-turn precheck signal");
    } catch (err) {
      expect(err).toBeInstanceOf(MidTurnPrecheckSignal);
      const signal = err as MidTurnPrecheckSignal;
      expect(signal.name).toBe("MidTurnPrecheckSignal");
      expect(signal.request.route).toBe("compact_then_truncate");
      expect(typeof signal.request.overflowTokens).toBe("number");
      expect(typeof signal.request.toolResultReducibleChars).toBe("number");
    }
  });

  it("does not run mid-turn precheck when no new tool result was appended", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeUser("u".repeat(80_000))];

    const transformed = await applyMidTurnPrecheckGuardToContext(agent, contextForNextCall, {
      contextWindowTokens: 200_000,
      contextTokenBudget: 20_000,
      reserveTokens: 12_000,
      prePromptMessageCount: 0,
    });

    expect(transformed).toBe(contextForNextCall);
  });

  it("uses compact_only route when mid-turn overflow is not reducible by tool truncation", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(80_000)),
      makeToolResult("call_small", "small output"),
    ];

    try {
      await applyMidTurnPrecheckGuardToContext(agent, contextForNextCall, {
        contextWindowTokens: 200_000,
        contextTokenBudget: 20_000,
        reserveTokens: 12_000,
        prePromptMessageCount: 1,
      });
      throw new Error("expected mid-turn precheck signal");
    } catch (err) {
      expect(err).toBeInstanceOf(MidTurnPrecheckSignal);
      expect((err as MidTurnPrecheckSignal).request.route).toBe("compact_only");
    }
  });
  it("does not count tool-result details toward the context budget", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeToolResultWithDetails("call_small_text", "x".repeat(100), "d".repeat(50_000)),
      makeToolResultWithDetails("call_another", "y".repeat(120), "e".repeat(80_000)),
    ];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];

    expect(transformed).toBe(contextForNextCall);
    expect(getToolResultText(transformed[0])).toBe("x".repeat(100));
    expect(getToolResultText(transformed[1])).toBe("y".repeat(120));
    expect((contextForNextCall[0] as { details?: unknown }).details).toBeDefined();
    expect((contextForNextCall[1] as { details?: unknown }).details).toBeDefined();
  });

  it("ignores large tool-result details when deciding preemptive overflow", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("small user prompt"),
      makeToolResultWithDetails("call_1", "a".repeat(50), "d".repeat(30_000)),
      makeToolResultWithDetails("call_2", "b".repeat(50), "d".repeat(30_000)),
      makeToolResultWithDetails("call_3", "c".repeat(50), "d".repeat(30_000)),
      makeToolResultWithDetails("call_4", "e".repeat(50), "d".repeat(30_000)),
    ];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];

    expect(transformed).toBe(contextForNextCall);
  });
});

type MockedEngine = ContextEngine & {
  afterTurn: ReturnType<typeof vi.fn>;
  assemble: ReturnType<typeof vi.fn>;
  ingest: ReturnType<typeof vi.fn>;
  ingestBatch?: ReturnType<typeof vi.fn>;
};

function makeMockEngine(
  overrides: {
    assemble?: (
      params: Parameters<ContextEngine["assemble"]>[0],
    ) => Promise<{ messages: AgentMessage[]; estimatedTokens: number }>;
    afterTurn?: (params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => Promise<void>;
    omitAfterTurn?: boolean;
    ingest?: (params: Parameters<ContextEngine["ingest"]>[0]) => Promise<{ ingested: boolean }>;
    ingestBatch?: (
      params: Parameters<NonNullable<ContextEngine["ingestBatch"]>>[0],
    ) => Promise<{ ingestedCount: number }>;
    omitIngestBatch?: boolean;
  } = {},
): MockedEngine {
  const defaultAfterTurn = vi.fn(async () => {});
  const defaultAssemble = vi.fn(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
    messages: params.messages,
    estimatedTokens: 0,
  }));
  const defaultIngest = vi.fn(async () => ({ ingested: true }));
  const defaultIngestBatch = vi.fn(
    async (params: Parameters<NonNullable<ContextEngine["ingestBatch"]>>[0]) => ({
      ingestedCount: params.messages.length,
    }),
  );
  const afterTurn = overrides.omitAfterTurn
    ? undefined
    : overrides.afterTurn
      ? vi.fn(overrides.afterTurn)
      : defaultAfterTurn;
  const assemble = overrides.assemble ? vi.fn(overrides.assemble) : defaultAssemble;
  const ingest = overrides.ingest ? vi.fn(overrides.ingest) : defaultIngest;
  const ingestBatch = overrides.omitIngestBatch
    ? undefined
    : overrides.ingestBatch
      ? vi.fn(overrides.ingestBatch)
      : defaultIngestBatch;
  const engine = {
    info: {
      id: "test-engine",
      name: "Test Engine",
      version: "0.0.1",
      ownsCompaction: true,
    },
    ingest,
    assemble,
    ...(ingestBatch ? { ingestBatch } : {}),
    ...(afterTurn ? { afterTurn } : {}),
  } as unknown as MockedEngine;
  return engine;
}

async function callTransform(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  messages: AgentMessage[],
) {
  return await agent.transformContext?.(messages, new AbortController().signal);
}

describe("installContextEngineLoopHook", () => {
  const sessionId = "test-session-id";
  const sessionKey = "agent:main:subagent:test";
  const sessionFile = "/tmp/test-session.jsonl";
  const tokenBudget = 4096;
  const modelId = "test-model";

  function installHook(
    agent: ReturnType<typeof makeGuardableAgent>,
    engine: MockedEngine,
    prePromptCount?: number,
    getRuntimeContext?: (params: {
      messages: AgentMessage[];
      prePromptMessageCount: number;
    }) => Record<string, unknown> | undefined,
    onAfterTurnCheckpoint?: (messageCount: number) => void,
  ): () => void {
    return installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
      ...(prePromptCount !== undefined ? { getPrePromptMessageCount: () => prePromptCount } : {}),
      ...(getRuntimeContext ? { getRuntimeContext } : {}),
      ...(onAfterTurnCheckpoint ? { onAfterTurnCheckpoint } : {}),
    });
  }

  async function callAfterInitialToolResult(
    agent: ReturnType<typeof makeGuardableAgent>,
    options: { includeSecondUser?: boolean; firstResultText?: string } = {},
  ): Promise<{ initial: AgentMessage[]; withNew: AgentMessage[]; transformed: unknown }> {
    const initial = [
      makeUser("first"),
      makeToolResult("call_1", options.firstResultText ?? "result"),
    ];
    await callTransform(agent, initial);

    const withNew =
      options.includeSecondUser === false
        ? [...initial, makeToolResult("call_2", "r2")]
        : [...initial, makeUser("second"), makeToolResult("call_2", "r2")];
    const transformed = await callTransform(agent, withNew);
    return { initial, withNew, transformed };
  }

  it("returns early when the current messages match the pre-prompt baseline", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine, 2);

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    const transformed = await callTransform(agent, messages);

    expect(transformed).toBe(messages);
    expect(engine.afterTurn).not.toHaveBeenCalled();
    expect(engine.assemble).not.toHaveBeenCalled();
  });

  it("processes the first call when messages already exceed the pre-prompt baseline", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine, 1);

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, messages);

    expect(engine.afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnParams = recordMockArg(engine.afterTurn);
    expect(afterTurnParams?.prePromptMessageCount).toBe(1);
    expect(afterTurnParams?.messages).toBe(messages);
    expect(engine.assemble).toHaveBeenCalledTimes(1);
  });

  it("passes runtimeContext through loop-hook afterTurn calls", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine, 1, () => ({
      provider: "anthropic",
      modelId: modelId,
      promptCache: {
        retention: "short",
        lastCacheTouchAt: 123,
      },
    }));

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, messages);

    expect(engine.afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnParams = recordMockArg(engine.afterTurn);
    expect(afterTurnParams?.prePromptMessageCount).toBe(1);
    expect(afterTurnParams?.runtimeContext).toEqual({
      provider: "anthropic",
      modelId,
      promptCache: {
        retention: "short",
        lastCacheTouchAt: 123,
      },
    });
  });

  it("passes loop messages and the prompt fence into the runtimeContext callback", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    const getRuntimeContext = vi.fn(() => ({ provider: "anthropic" }));
    installHook(agent, engine, 1, getRuntimeContext);

    const messages = [
      makeUser("first"),
      makeAssistant("tool use", { usage: { cacheRead: 40, total: 50 }, timestamp: 456 }),
      makeToolResult("call_1", "result"),
    ];
    await callTransform(agent, messages);

    expect(getRuntimeContext).toHaveBeenCalledWith({
      messages,
      prePromptMessageCount: 1,
    });
  });

  it("calls afterTurn and assemble when new messages are appended after the first call", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine);

    const initial = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, initial);

    const withNew = [...initial, makeUser("second"), makeToolResult("call_2", "r2")];
    await callTransform(agent, withNew);

    expect(engine.afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnParams = recordMockArg(engine.afterTurn);
    expect(afterTurnParams?.prePromptMessageCount).toBe(2);
    expect(afterTurnParams?.messages).toBe(withNew);
    expect(engine.assemble).toHaveBeenCalledTimes(1);
  });

  it("advances the fence across multiple iterations", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine);

    const batch0 = [makeUser("h1"), makeToolResult("c1", "r1")];
    await callTransform(agent, batch0);

    const batch1 = [...batch0, makeUser("h2"), makeToolResult("c2", "r2")];
    await callTransform(agent, batch1);

    const batch2 = [...batch1, makeUser("h3"), makeToolResult("c3", "r3")];
    await callTransform(agent, batch2);

    expect(engine.afterTurn).toHaveBeenCalledTimes(2);
    expect(recordMockArg(engine.afterTurn).prePromptMessageCount).toBe(2);
    expect(recordMockArg(engine.afterTurn, 1).prePromptMessageCount).toBe(4);
  });

  it("reports the latest delivered afterTurn checkpoint", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    const onAfterTurnCheckpoint = vi.fn();
    installHook(agent, engine, undefined, undefined, onAfterTurnCheckpoint);

    const batch0 = [makeUser("h1"), makeToolResult("c1", "r1")];
    await callTransform(agent, batch0);

    const batch1 = [...batch0, makeUser("h2"), makeToolResult("c2", "r2")];
    await callTransform(agent, batch1);

    expect(onAfterTurnCheckpoint).toHaveBeenCalledTimes(1);
    expect(onAfterTurnCheckpoint).toHaveBeenCalledWith(batch1.length);
  });

  it("skips afterTurn and assemble when messages have not changed", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine);

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, messages);
    await callTransform(agent, messages);
    await callTransform(agent, messages);

    expect(engine.afterTurn).not.toHaveBeenCalled();
    expect(engine.assemble).not.toHaveBeenCalled();
  });

  it("returns the assembled view when its length differs from the source", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    installHook(agent, engine);

    const { transformed } = await callAfterInitialToolResult(agent, {
      includeSecondUser: false,
      firstResultText: "r",
    });

    expect(transformed).toBe(compactedView);
  });

  it("clears an assembled view when the engine fails on a later source", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    engine.assemble
      .mockResolvedValueOnce({ messages: compactedView, estimatedTokens: 0 })
      .mockRejectedValueOnce(new Error("assemble failed"))
      .mockImplementation(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: params.messages,
        estimatedTokens: 0,
      }));
    installHook(agent, engine, 1);

    const firstSource = [makeUser("first"), makeToolResult("call_1", "r1")];
    expect(await callTransform(agent, firstSource)).toBe(compactedView);

    const secondSource = [...firstSource, makeToolResult("call_2", "r2")];
    expect(await callTransform(agent, secondSource)).toBe(secondSource);

    const retry = await callTransform(agent, secondSource);
    expect(retry).toBe(secondSource);
    expect(retry).not.toBe(compactedView);
    expect(engine.assemble).toHaveBeenCalledTimes(3);
  });

  it("clears an assembled view when source history shrinks", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    engine.assemble.mockResolvedValueOnce({ messages: compactedView, estimatedTokens: 0 });
    engine.assemble.mockImplementation(
      async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: params.messages,
        estimatedTokens: 0,
      }),
    );
    installHook(agent, engine, 1);

    const longSource = [
      makeUser("first"),
      makeToolResult("call_1", "r1"),
      makeToolResult("call_2", "r2"),
    ];
    expect(await callTransform(agent, longSource)).toBe(compactedView);

    const resetSource = [makeUser("reset")];
    expect(await callTransform(agent, resetSource)).toBe(resetSource);
  });

  it("clears an assembled view when source history resets at the same length", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    engine.assemble.mockResolvedValueOnce({ messages: compactedView, estimatedTokens: 0 });
    engine.assemble.mockImplementation(
      async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: params.messages,
        estimatedTokens: 0,
      }),
    );
    installHook(agent, engine, 1);

    const source = [
      makeUser("first"),
      makeToolResult("call_1", "r1"),
      makeToolResult("call_2", "r2"),
    ];
    expect(await callTransform(agent, source)).toBe(compactedView);

    const resetSource = [makeUser("reset"), makeToolResult("call_3", "r3"), makeUser("fresh")];
    expect(await callTransform(agent, resetSource)).toBe(resetSource);
  });

  it("returns the assembled view when the engine rewrites content without changing count", async () => {
    const agent = makeGuardableAgent();
    const rewrittenView = [makeUser("rewritten-1"), makeUser("rewritten-2")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: rewrittenView, estimatedTokens: 0 }),
    });
    installHook(agent, engine);

    const { transformed } = await callAfterInitialToolResult(agent, {
      includeSecondUser: false,
      firstResultText: "r",
    });

    // Same count (2) but different array reference — engine's view should be used
    expect(transformed).toBe(rewrittenView);
  });

  it("returns the source when the engine returns the same array reference", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine);

    const { transformed, withNew } = await callAfterInitialToolResult(agent);

    expect(transformed).toBe(withNew);
  });

  it("does not mutate the source messages array", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    installHook(agent, engine);

    const initial = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, initial);

    const sourceMessages = [...initial, makeUser("second"), makeToolResult("call_2", "r2")];
    const sourceCopy = [...sourceMessages];
    await callTransform(agent, sourceMessages);

    expect(sourceMessages).toEqual(sourceCopy);
  });

  it("ingests new messages in batches when afterTurn is absent", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({ omitAfterTurn: true });
    installHook(agent, engine);

    const batch0 = [makeUser("first"), makeToolResult("call_1", "r1")];
    await callTransform(agent, batch0);

    const batch1 = [...batch0, makeUser("second"), makeToolResult("call_2", "r2")];
    await callTransform(agent, batch1);

    const batch2 = [...batch1, makeUser("third"), makeToolResult("call_3", "r3")];
    await callTransform(agent, batch2);

    expect(engine.ingestBatch).toHaveBeenCalledTimes(2);
    const ingestBatch = engine.ingestBatch;
    if (!ingestBatch) {
      throw new Error("expected ingestBatch mock");
    }
    expect(recordMockArg(ingestBatch).messages).toEqual(batch1.slice(2));
    expect(recordMockArg(ingestBatch, 1).messages).toEqual(batch2.slice(4));
    expect(engine.assemble).toHaveBeenCalledTimes(2);
  });

  it("falls back to per-message ingest when ingestBatch is absent", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({ omitAfterTurn: true, omitIngestBatch: true });
    installHook(agent, engine, 1);

    const toolResult = makeToolResult("call_1", "r1");
    const messages = [makeUser("first"), toolResult];
    await callTransform(agent, messages);

    expect(engine.ingest).toHaveBeenCalledTimes(1);
    const ingestParams = recordMockArg(engine.ingest);
    expect(ingestParams?.sessionId).toBe(sessionId);
    expect(ingestParams?.sessionKey).toBe(sessionKey);
    expect(ingestParams?.message).toBe(toolResult);
    expect(engine.assemble).toHaveBeenCalledTimes(1);
  });

  it("falls through to source messages when engine.afterTurn throws", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({
      afterTurn: async () => {
        throw new Error("engine afterTurn boom");
      },
    });
    installHook(agent, engine);

    const { transformed, withNew } = await callAfterInitialToolResult(agent);

    expect(transformed).toBe(withNew);
  });

  it("falls through to source messages when engine.assemble throws", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({
      assemble: async () => {
        throw new Error("engine assemble boom");
      },
    });
    installHook(agent, engine);

    const { transformed, withNew } = await callAfterInitialToolResult(agent);

    expect(transformed).toBe(withNew);
  });

  it("invokes any pre-existing transformContext before the engine sees messages", async () => {
    const upstream = vi.fn(async (messages: AgentMessage[]) => [...messages, makeUser("appended")]);
    const agent = makeGuardableAgent(upstream);
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    installHook(agent, engine);

    // First call: upstream runs (1 msg -> 2 msgs), fence set to 2, returns early
    await callTransform(agent, [makeUser("first")]);
    expect(upstream).toHaveBeenCalledTimes(1);

    // Second call: upstream runs (2 msgs -> 3 msgs), hasNewMessages = true, assemble fires
    const transformed = await callTransform(agent, [makeUser("first"), makeUser("second")]);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(transformed).toBe(compactedView);
  });

  it("restores the previous transformContext when the returned dispose is called", () => {
    const upstream = vi.fn(async (messages: AgentMessage[]) => messages);
    const agent = makeGuardableAgent(upstream);
    const engine = makeMockEngine();
    const dispose = installHook(agent, engine);

    dispose();

    expect(agent.transformContext).toBe(upstream);
  });

  it("returns the cached assembled view on unchanged iterations instead of raw source", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    installHook(agent, engine);

    const { withNew, transformed: firstResult } = await callAfterInitialToolResult(agent, {
      includeSecondUser: false,
      firstResultText: "r",
    });
    expect(firstResult).toBe(compactedView);

    // Retry with same messages: should return cached assembled view, not raw
    const retryResult = await callTransform(agent, withNew);
    expect(retryResult).toBe(compactedView);
    expect(engine.assemble).toHaveBeenCalledTimes(1);
  });
});
