import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession } from "../../sessions/index.js";
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
  isCacheTtlEligibleProvider: hoisted.isCacheTtlEligibleProvider,
  readLastCacheTtlTimestamp: hoisted.readLastCacheTtlTimestamp,
}));

import { installEmbeddedAttemptContextGuards } from "./attempt-context-guards.js";

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
    getSystemPrompt: () => "system prompt",
    isOpenAIResponsesApi: false,
    repairToolUseResultPairing: false,
    sessionAgentId: "main",
    sessionManager: {},
    settingsManager,
    ...overrides,
  };
}

describe("installEmbeddedAttemptContextGuards", () => {
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

  it("projects expired cache-TTL history before context-engine assembly once per attempt", async () => {
    const now = Date.now();
    hoisted.isCacheTtlEligibleProvider.mockReturnValue(true);
    hoisted.readLastCacheTtlTimestamp.mockReturnValue(now - 300_000);
    const input = createInput({
      activeContextEngine: { info: { id: "test-engine", ownsCompaction: true } },
    });
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
    const messages = [
      { role: "user", content: "first", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "a1" }], timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "old-tool",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(5_000) }],
        timestamp: 1,
      },
      { role: "assistant", content: [{ type: "text", text: "a2" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "a3" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "a4" }], timestamp: 1 },
    ] as AgentMessage[];

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
      text: expect.stringContaining("[Tool result trimmed:"),
    });

    await input.activeSession.agent.transformContext?.(messages, new AbortController().signal);
    const secondTool = engineMessages?.find((message) => message.role === "toolResult");
    expect(secondTool?.content[0]).toMatchObject({ type: "text", text: "x".repeat(5_000) });

    guards.remove();
    expect(input.activeSession.agent.transformContext).toBe(originalTransform);
  });
});
