import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";

const hoisted = vi.hoisted(() => ({
  buildAgentHookContextChannelFields: vi.fn(() => ({ channel: "discord" })),
  buildAgentHookContextIdentityFields: vi.fn(() => ({ senderId: "sender-1" })),
  emitTrustedDiagnosticEvent: vi.fn(),
  hasHooks: vi.fn(() => true),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    isEnabled: vi.fn(() => false),
    warn: vi.fn(),
  },
  onExecutionPhase: vi.fn(),
  recordStage: vi.fn(),
  recordTrajectoryEvent: vi.fn(),
  runLlmInput: vi.fn(
    async (
      _event: {
        historyMessages?: unknown[];
        imagesCount?: number;
        prompt?: string;
        tools?: unknown[];
      },
      _context: Record<string, unknown>,
    ) => undefined,
  ),
  toTrajectoryToolDefinitions: vi.fn((tools: ReadonlyArray<{ name?: string }>) =>
    tools.map((tool) => ({ name: tool.name })),
  ),
}));

vi.mock("../../../infra/diagnostic-events.js", () => ({
  emitTrustedDiagnosticEvent: hoisted.emitTrustedDiagnosticEvent,
}));
vi.mock("../../../plugins/hook-agent-context.js", () => ({
  buildAgentHookContextChannelFields: hoisted.buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields: hoisted.buildAgentHookContextIdentityFields,
}));
vi.mock("../../../trajectory/runtime.js", () => ({
  toTrajectoryToolDefinitions: hoisted.toTrajectoryToolDefinitions,
}));
vi.mock("../logger.js", () => ({ log: hoisted.log }));

import { observeEmbeddedAttemptPrompt } from "./attempt-prompt-observability.js";

type PromptObservabilityInput = Parameters<typeof observeEmbeddedAttemptPrompt>[0];

function createInput(overrides: Partial<PromptObservabilityInput> = {}): PromptObservabilityInput {
  const sessionMessages: AgentMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "history" }],
      timestamp: 1,
    },
  ];
  return {
    attempt: {
      messageChannel: "discord",
      modelId: "model-1",
      onExecutionPhase: hoisted.onExecutionPhase,
      provider: "provider-1",
      runId: "run-1",
      senderId: "sender-1",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main:discord:channel-1",
      trigger: "user",
      workspaceDir: "/tmp/workspace",
    },
    cacheTrace: { recordStage: hoisted.recordStage },
    contextTokenBudget: 32_000,
    diagnosticTrace: {
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
    },
    effectivePrompt: "effective prompt",
    effectiveTools: [{ name: "visible-tool" }],
    hookAgentId: "main",
    hookMessagesForCurrentPrompt: sessionMessages,
    hookRunner: {
      hasHooks: hoisted.hasHooks,
      runLlmInput: hoisted.runLlmInput,
    },
    imageCount: 2,
    isRawModelRun: false,
    llmBoundaryPromptForPrecheck: "[boundary] model prompt",
    promptForModel: "model prompt",
    promptSubmissionRuntimeOnly: false,
    reserveTokens: 4_096,
    runTrace: {
      traceId: "1".repeat(32),
      spanId: "3".repeat(16),
    },
    sessionMessages,
    skipPromptSubmission: false,
    streamStrategy: "provider-stream",
    systemPromptForHook: "system prompt",
    systemPromptText: "system prompt",
    toolSearchCompacted: true,
    tools: [{ name: "hook-tool" }],
    trajectoryRecorder: { recordEvent: hoisted.recordTrajectoryEvent },
    transcriptLeafId: "leaf-1",
    transport: "sse",
    uncompactedEffectiveTools: [{ name: "visible-tool" }, { name: "deferred-tool" }],
    ...overrides,
  } as PromptObservabilityInput;
}

describe("observeEmbeddedAttemptPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.hasHooks.mockReturnValue(true);
    hoisted.log.isEnabled.mockReturnValue(false);
  });

  it("records the assembled prompt boundary and dispatches a cloned llm_input snapshot", () => {
    const input = createInput();

    expect(observeEmbeddedAttemptPrompt(input)).toEqual({ skipPromptSubmission: false });

    expect(hoisted.recordStage).toHaveBeenNthCalledWith(1, "prompt:before", {
      prompt: "model prompt",
      messages: input.sessionMessages,
    });
    expect(hoisted.recordStage).toHaveBeenNthCalledWith(2, "prompt:images", {
      prompt: "model prompt",
      messages: input.sessionMessages,
      note: "images: prompt=2",
    });
    expect(hoisted.recordTrajectoryEvent).toHaveBeenCalledWith(
      "context.compiled",
      expect.objectContaining({
        imagesCount: 2,
        providerVisibleTools: [{ name: "visible-tool" }],
        tools: [{ name: "visible-tool" }, { name: "deferred-tool" }],
        transcriptLeafId: "leaf-1",
      }),
    );
    expect(hoisted.emitTrustedDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "context.assembled",
        contextTokenBudget: 32_000,
        historyTextChars: 7,
        messageCount: 1,
        promptChars: 16,
        reserveTokens: 4_096,
      }),
    );
    expect(hoisted.onExecutionPhase).toHaveBeenCalledWith({
      phase: "context_assembled",
      provider: "provider-1",
      model: "model-1",
    });
    expect(hoisted.runLlmInput).toHaveBeenCalledOnce();
    const [event, context] = hoisted.runLlmInput.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      prompt: "[boundary] model prompt",
      imagesCount: 2,
      tools: [{ name: "hook-tool" }],
    });
    expect(event?.historyMessages).toEqual(input.hookMessagesForCurrentPrompt);
    expect(event?.historyMessages).not.toBe(input.hookMessagesForCurrentPrompt);
    expect(context).toMatchObject({
      agentId: "main",
      channel: "discord",
      senderId: "sender-1",
    });
  });

  it("marks a blank current prompt as skipped while preserving its compiled trace", () => {
    const input = createInput({
      imageCount: 0,
      llmBoundaryPromptForPrecheck: "   ",
      promptForModel: "   ",
    });

    expect(observeEmbeddedAttemptPrompt(input)).toEqual({ skipPromptSubmission: true });

    expect(hoisted.recordTrajectoryEvent).toHaveBeenNthCalledWith(
      1,
      "context.compiled",
      expect.any(Object),
    );
    expect(hoisted.recordTrajectoryEvent).toHaveBeenNthCalledWith(2, "prompt.skipped", {
      reason: "blank_user_prompt",
      prompt: "   ",
      messages: input.sessionMessages,
      imagesCount: 0,
    });
    expect(hoisted.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("embedded run prompt skipped: blank user prompt"),
    );
    expect(hoisted.runLlmInput).not.toHaveBeenCalled();
  });

  it("keeps an already-blocked prompt out of cache, trajectory, and hook dispatch", () => {
    const input = createInput({ skipPromptSubmission: true });

    expect(observeEmbeddedAttemptPrompt(input)).toEqual({ skipPromptSubmission: true });

    expect(hoisted.recordStage).not.toHaveBeenCalled();
    expect(hoisted.recordTrajectoryEvent).not.toHaveBeenCalled();
    expect(hoisted.runLlmInput).not.toHaveBeenCalled();
    expect(hoisted.emitTrustedDiagnosticEvent).toHaveBeenCalledOnce();
  });
});
