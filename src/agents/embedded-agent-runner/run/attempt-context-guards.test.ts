import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { AssistantMessage, Model } from "../../../llm/types.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession } from "../../sessions/index.js";
import { makeZeroUsageSnapshot } from "../../usage.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";

const hoisted = vi.hoisted(() => ({
  installContextEngineLoopHook: vi.fn(),
  installToolResultContextGuard: vi.fn(),
  installHistoryImagePruneContextTransform: vi.fn(),
  invalidateComputerFrameIfMissing: vi.fn(),
  isCacheTtlEligibleProvider: vi.fn(() => false),
  readLastCacheTtlTimestamp: vi.fn(() => null as number | null),
}));

vi.mock("../tool-result-context-guard.js", () => ({
  installContextEngineLoopHook: hoisted.installContextEngineLoopHook,
  installToolResultContextGuard: hoisted.installToolResultContextGuard,
}));
vi.mock("./history-image-prune.js", () => ({
  installHistoryImagePruneContextTransform: hoisted.installHistoryImagePruneContextTransform,
}));
vi.mock("../../tools/computer-tool.js", () => ({
  invalidateComputerFrameIfMissing: hoisted.invalidateComputerFrameIfMissing,
}));
vi.mock("../cache-ttl.js", () => ({
  readCacheTtlEntries: () => [],
  isCacheTtlEligibleProvider: hoisted.isCacheTtlEligibleProvider,
  readLastCacheTtlTimestamp: hoisted.readLastCacheTtlTimestamp,
}));

import { installEmbeddedAttemptContextGuards } from "./attempt-setup.js";

function createInput(overrides: Record<string, unknown> = {}) {
  const activeSession = {
    agent: { transformContext: undefined },
  } as unknown as AgentSession;
  const settingsManager = {
    getBlockImages: vi.fn(() => false),
    getCompactionReserveTokens: vi.fn(() => 64),
  } as unknown as AgentSession["settingsManager"];
  return {
    activeSession,
    agentDir: "/tmp/agent",
    attempt: {
      config: {
        agents: { defaults: { compaction: { midTurnPrecheck: { enabled: true } } } },
      },
      contextTokenBudget: 1_024,
      model: { api: "anthropic-messages", contextWindow: 2_048 },
      modelId: "model-1",
      provider: "provider-1",
      sessionFile: "/tmp/session.jsonl",
    },
    computerContextEpoch: { value: 3 },
    dropThinkingBlocksForEstimate: false,
    effectiveCwd: "/tmp/workspace",
    effectiveWorkspace: "/tmp/workspace",
    getPrePromptMessageCount: () => 4,
    getPromptCache: () => undefined,
    getPromptCacheRetention: () => "short" as const,
    getCompactionReplayEnabled: () => false,
    getServerToolClearingEnabled: () => false,
    toolResultPromptProjectionState: createToolResultPromptProjectionState(),
    getSystemPrompt: () => "system prompt",
    isOpenAIResponsesApi: false,
    repairToolUseResultPairing: false,
    sessionAgentId: "main",
    sessionManager: {},
    settingsManager,
    ...overrides,
  };
}

const cacheModel: Model = {
  id: "claude-sonnet-4-6",
  name: "Synthetic cache model",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 2_048,
  maxTokens: 1_024,
};

function prunableHistory(): AgentMessage[] {
  const assistant = (text: string): AssistantMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: cacheModel.api,
    provider: cacheModel.provider,
    model: cacheModel.id,
    usage: makeZeroUsageSnapshot(),
    stopReason: "stop",
    timestamp: 1,
  });
  return [
    { role: "user", content: "first", timestamp: 1 },
    assistant("a1"),
    {
      role: "toolResult",
      toolCallId: "old-tool",
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(5_000) }],
      isError: false,
      timestamp: 1,
    },
    assistant("a2"),
    assistant("a3"),
    assistant("a4"),
  ];
}

describe("installEmbeddedAttemptContextGuards", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.installContextEngineLoopHook.mockReturnValue(vi.fn());
    hoisted.installToolResultContextGuard.mockReturnValue(vi.fn());
    hoisted.installHistoryImagePruneContextTransform.mockReturnValue(vi.fn());
    hoisted.isCacheTtlEligibleProvider.mockReturnValue(false);
    hoisted.readLastCacheTtlTimestamp.mockReturnValue(null);
  });

  it("tracks mid-turn requests and restores attempt-local transforms", async () => {
    const input = createInput();
    const originalTransform = input.activeSession.agent.transformContext;
    const guards = installEmbeddedAttemptContextGuards(input as never);
    const guardOptions = hoisted.installToolResultContextGuard.mock.calls[0]?.[0];
    const request: MidTurnPrecheckRequest = {
      route: "compact_then_truncate",
      estimatedPromptTokens: 1_200,
      promptBudgetBeforeReserve: 1_024,
      overflowTokens: 176,
      toolResultReducibleChars: 800,
      effectiveReserveTokens: 64,
    };
    guardOptions.midTurnPrecheck.onMidTurnPrecheck(request);

    expect(guards.takePendingMidTurnPrecheckRequest()).toBe(request);
    expect(guards.takePendingMidTurnPrecheckRequest()).toBeNull();
    expect(guardOptions).toMatchObject({
      contextWindowTokens: 1_024,
      midTurnPrecheck: {
        enabled: true,
        contextTokenBudget: 1_024,
        toolResultMaxChars: expect.any(Number),
      },
    });

    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    ];
    await input.activeSession.agent.transformContext?.(messages, new AbortController().signal);
    expect(hoisted.invalidateComputerFrameIfMissing).toHaveBeenCalledWith({
      contextEpoch: input.computerContextEpoch,
      imagesBlocked: false,
      messages,
    });

    const removeToolResultGuard = hoisted.installToolResultContextGuard.mock.results[0]?.value;
    const removeHistoryGuard =
      hoisted.installHistoryImagePruneContextTransform.mock.results[0]?.value;
    guards.remove();
    expect(input.activeSession.agent.transformContext).toBe(originalTransform);
    expect(removeHistoryGuard).toHaveBeenCalledOnce();
    expect(removeToolResultGuard).toHaveBeenCalledOnce();
  });

  it("composes context-engine and tool-result cleanup while exposing checkpoints", () => {
    const activeContextEngine = {
      info: { id: "test-engine", ownsCompaction: true },
    };
    const guards = installEmbeddedAttemptContextGuards(
      createInput({
        activeContextEngine,
        repairToolUseResultPairing: true,
      }) as never,
    );
    const loopOptions = hoisted.installContextEngineLoopHook.mock.calls[0]?.[0];
    loopOptions.onAfterTurnCheckpoint(17);

    expect(guards.getAfterTurnCheckpoint()).toBe(17);
    expect(loopOptions).toMatchObject({
      contextEngine: activeContextEngine,
      modelId: "model-1",
      repairAssembledMessages: expect.any(Function),
    });

    const removeLoopHook = hoisted.installContextEngineLoopHook.mock.results[0]?.value;
    const removeToolResultGuard = hoisted.installToolResultContextGuard.mock.results[0]?.value;
    guards.remove();
    expect(removeToolResultGuard).toHaveBeenCalledOnce();
    expect(removeLoopHook).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "attempt configuration is absent", config: undefined },
    {
      name: "context pruning is not configured",
      config: { agents: { defaults: {} } },
    },
    {
      name: "context pruning has no mode",
      config: { agents: { defaults: { contextPruning: {} } } },
    },
    {
      name: "context pruning is explicitly off",
      config: { agents: { defaults: { contextPruning: { mode: "off" } } } },
    },
  ])("does not inspect providers when $name", ({ config }) => {
    hoisted.isCacheTtlEligibleProvider.mockReturnValue(true);
    const input = createInput();
    input.attempt = { ...input.attempt, config: config as never };

    const guards = installEmbeddedAttemptContextGuards(input as never);

    expect(hoisted.isCacheTtlEligibleProvider).not.toHaveBeenCalled();
    expect(hoisted.readLastCacheTtlTimestamp).not.toHaveBeenCalled();
    guards.remove();
  });

  it("does not install cache-TTL pruning for an ineligible provider", async () => {
    const input = createInput();
    input.attempt = {
      ...input.attempt,
      config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } } as never,
    };
    const originalTransform = vi.fn(async (messages: AgentMessage[]) => messages);
    input.activeSession.agent.transformContext = originalTransform;

    const guards = installEmbeddedAttemptContextGuards(input as never);

    expect(hoisted.isCacheTtlEligibleProvider).toHaveBeenCalledExactlyOnceWith(
      "provider-1",
      "model-1",
      "anthropic-messages",
    );
    expect(hoisted.readLastCacheTtlTimestamp).not.toHaveBeenCalled();
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    ];
    expect(
      await input.activeSession.agent.transformContext?.(messages, new AbortController().signal),
    ).toBe(messages);
    expect(originalTransform).toHaveBeenCalledOnce();

    guards.remove();
    expect(input.activeSession.agent.transformContext).toBe(originalTransform);
  });

  it.each([
    { scenario: "warm cache", age: 290_000, thresholdCrossing: false, outcome: "success" },
    { scenario: "threshold crossing", age: 310_000, thresholdCrossing: true, outcome: "success" },
    {
      scenario: "failure before dispatch",
      age: 290_000,
      thresholdCrossing: false,
      outcome: "throw",
    },
    { scenario: "provider error", age: 290_000, thresholdCrossing: false, outcome: "error" },
    { scenario: "aborted request", age: 290_000, thresholdCrossing: false, outcome: "aborted" },
    {
      scenario: "stream without terminal result",
      age: 290_000,
      thresholdCrossing: false,
      outcome: "empty",
    },
  ] as const)(
    "uses successful request start for pruning after $scenario",
    async ({ age, thresholdCrossing, outcome }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const requestStart = 1_000_000;
      vi.setSystemTime(requestStart);
      hoisted.isCacheTtlEligibleProvider.mockReturnValue(true);
      hoisted.readLastCacheTtlTimestamp.mockReturnValue(requestStart - age);
      const input = createInput();
      input.attempt = {
        ...input.attempt,
        contextTokenBudget: thresholdCrossing ? 10_000 : 1_024,
        config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } } as never,
      };
      const guards = installEmbeddedAttemptContextGuards(input as never);
      const history = prunableHistory();
      const project = (messages: AgentMessage[]) =>
        input.activeSession.agent.transformContext!(messages, new AbortController().signal);
      const first = await project(history);
      expect(JSON.stringify(first)).toBe(JSON.stringify(history));
      const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "continue" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: makeZeroUsageSnapshot(),
        stopReason: outcome === "error" || outcome === "aborted" ? outcome : "toolUse",
        timestamp: requestStart,
      };
      const onSucceeded = vi.fn(guards.recordCacheTouch);
      const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
        () => {
          if (outcome === "throw") {
            throw new Error("failed before dispatch");
          }
          const stream = createAssistantMessageEventStream();
          // Completion is deliberately later than request start; using completion time
          // would incorrectly keep the cache warm past the final idle check below.
          vi.setSystemTime(Date.now() + 10_000);
          if (outcome === "empty") {
            stream.end();
          } else if (outcome === "error" || outcome === "aborted") {
            stream.push({ type: "error", reason: outcome, error: response });
          } else {
            stream.push({ type: "done", reason: "toolUse", message: response });
          }
          return stream;
        },
        {
          runId: "cache-ttl-clock",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          trace: createDiagnosticTraceContext(),
          nextCallId: () => "cache-ttl-request",
          onSucceeded,
        },
      );
      try {
        if (outcome === "throw") {
          expect(() => wrapped(cacheModel, { messages: [] })).toThrow("failed before dispatch");
        } else {
          const stream = await wrapped(cacheModel, { messages: [] });
          for await (const _ of stream) {
            // Consume the provider completion.
          }
          if (outcome !== "empty") {
            await stream.result();
          }
        }
        vi.setSystemTime(requestStart + 20_000);
        const expanded = thresholdCrossing
          ? [
              ...history,
              {
                role: "toolResult" as const,
                toolCallId: "new-tool",
                toolName: "read",
                content: [{ type: "text" as const, text: "y".repeat(10_000) }],
                isError: false,
                timestamp: Date.now(),
              },
            ]
          : history;
        const second = await project(expanded);
        if (outcome === "success") {
          expect(JSON.stringify(second)).toBe(JSON.stringify(expanded));
          expect(onSucceeded).toHaveBeenCalledExactlyOnceWith(requestStart);
          // A second successful request starts its own TTL window.
          const nextStream = await wrapped(cacheModel, { messages: [] });
          await nextStream.result();
          expect(onSucceeded).toHaveBeenCalledTimes(2);
          expect(onSucceeded).toHaveBeenLastCalledWith(requestStart + 20_000);
          vi.setSystemTime(requestStart + 320_000);
          const expired = await project(expanded);
          expect(JSON.stringify(expired)).toContain("[Tool result trimmed:");
          expect(JSON.stringify(expired)).not.toBe(JSON.stringify(expanded));
        } else {
          expect(onSucceeded).not.toHaveBeenCalled();
          expect(JSON.stringify(second)).toContain("[Tool result trimmed:");
        }
        expect(JSON.stringify(history)).toContain("x".repeat(5_000));
      } finally {
        guards.remove();
      }
    },
  );

  it.each([false, true])(
    "keeps cache-TTL tool-loop bytes stable with server clearing=%s",
    async (serverClearing) => {
      const now = Date.now();
      hoisted.isCacheTtlEligibleProvider.mockReturnValue(true);
      hoisted.readLastCacheTtlTimestamp.mockReturnValue(now - 300_000);
      const input = createInput({
        activeContextEngine: { info: { id: "test-engine", ownsCompaction: true } },
        getServerToolClearingEnabled: () => serverClearing,
      });
      const earlierProjection = "[trimmed by an earlier client-side prune]";
      if (serverClearing) {
        // A projection made before this route took over (proxy/OAuth turn, or restored
        // from the transcript marker) must keep replaying under server clearing.
        const key = "tool:old-tool:1";
        input.toolResultPromptProjectionState.replacements.set(key, {
          content: [{ type: "text", text: earlierProjection }],
          cacheTtl: "soft",
        });
        input.toolResultPromptProjectionState.sourceHashByKey.set(
          key,
          createHash("sha256")
            .update(JSON.stringify(["x".repeat(5_000)]))
            .digest("base64url"),
        );
        input.toolResultPromptProjectionState.frozen.add(key);
      }
      input.attempt = {
        ...input.attempt,
        config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } } as never,
        model: { api: "anthropic-messages", contextWindow: 2_048 },
        modelId: "claude-sonnet-4-6",
        provider: "anthropic",
      };
      const originalTransform = vi.fn(async (messages: AgentMessage[]) => messages);
      input.activeSession.agent.transformContext = originalTransform;
      let engineMessages: AgentMessage[] | undefined;
      hoisted.installContextEngineLoopHook.mockImplementation(({ agent }) => {
        const previous = agent.transformContext;
        agent.transformContext = async (messages: AgentMessage[], signal: AbortSignal) => {
          const projected = await previous(messages, signal);
          engineMessages = projected;
          return projected;
        };
        return vi.fn(() => {
          agent.transformContext = previous;
        });
      });
      const messages = prunableHistory();

      const guards = installEmbeddedAttemptContextGuards(input as never);
      expect(hoisted.isCacheTtlEligibleProvider).toHaveBeenCalledExactlyOnceWith(
        "anthropic",
        "claude-sonnet-4-6",
        "anthropic-messages",
      );
      expect(hoisted.readLastCacheTtlTimestamp).toHaveBeenCalledExactlyOnceWith(
        input.sessionManager,
        {
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
        },
      );
      await input.activeSession.agent.transformContext?.(messages, new AbortController().signal);
      const firstTool = engineMessages?.find((message) => message.role === "toolResult");
      expect(firstTool?.content[0]).toMatchObject({
        type: "text",
        text: serverClearing ? earlierProjection : expect.stringContaining("[Tool result trimmed:"),
      });

      await input.activeSession.agent.transformContext?.(messages, new AbortController().signal);
      const secondTool = engineMessages?.find((message) => message.role === "toolResult");
      expect(secondTool?.content).toEqual(firstTool?.content);

      guards.remove();
      expect(input.activeSession.agent.transformContext).toBe(originalTransform);
    },
  );
});
