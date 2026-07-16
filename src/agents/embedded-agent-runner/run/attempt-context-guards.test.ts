import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession } from "../../sessions/index.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";

const hoisted = vi.hoisted(() => ({
  installContextEngineLoopHook: vi.fn(),
  installToolResultContextGuard: vi.fn(),
  installHistoryImagePruneContextTransform: vi.fn(),
  invalidateComputerFrameIfMissing: vi.fn(),
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
});
