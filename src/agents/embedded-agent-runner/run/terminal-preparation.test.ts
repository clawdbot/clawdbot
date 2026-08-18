import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { buildEmbeddedRunPayloads } from "./payloads.js";
import type { EmbeddedRunTerminalState } from "./terminal-outcome.js";

const payloadMocks = vi.hoisted(() => ({
  buildEmbeddedRunPayloads: vi.fn<typeof buildEmbeddedRunPayloads>(),
}));

vi.mock("./payloads.js", () => ({
  buildEmbeddedRunPayloads: payloadMocks.buildEmbeddedRunPayloads,
}));
vi.mock("./run-attempt-result.js", () => ({
  buildTraceToolSummary: () => undefined,
}));

function assistantMessage(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    role: "assistant",
    content: [
      {
        type: "text",
        text: "provider error details",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ],
    timestamp: 0,
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
  };
}

function attemptResult(
  overrides: Partial<EmbeddedRunAttemptWithReceiptEvidence> = {},
): EmbeddedRunAttemptWithReceiptEvidence {
  const assistant = assistantMessage("error");
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: "session-1",
    messagesSnapshot: [assistant],
    assistantTexts: ["provider error details"],
    toolMetas: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...overrides,
  };
}

async function prepareAttempt(input: {
  attempt: EmbeddedRunAttemptWithReceiptEvidence;
  currentAttemptCompletedAssistant?: AssistantMessage;
  terminalState: EmbeddedRunTerminalState;
}) {
  const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
  return prepareEmbeddedRunTerminal({
    runParams: {
      admittedRunContext: createTestAdmittedRunContext("run-focused"),
      sessionId: "session-focused",
      runId: "run-focused",
      workspaceDir: "/tmp/openclaw-test",
      prompt: "hi",
      trigger: "user",
      timeoutMs: 60_000,
    },
    attempt: input.attempt,
    currentAttemptCompletedAssistant: input.currentAttemptCompletedAssistant,
    provider: "openai",
    model: "gpt-5.4",
    activeErrorContext: { provider: "openai", model: "gpt-5.4" },
    authProfileStore: { version: 1, profiles: {} },
    sessionIdUsed: input.attempt.sessionIdUsed,
    outerContextTokenMeta: {},
    usageAccumulator: createUsageAccumulator(),
    contextRecoveryState: createEmbeddedRunContextRecoveryState(),
    resolvedToolResultFormat: "markdown",
    terminalState: input.terminalState,
  });
}

describe("prepareEmbeddedRunTerminal", () => {
  beforeEach(() => {
    payloadMocks.buildEmbeddedRunPayloads.mockReset().mockReturnValue([]);
  });

  it.each(["error", "aborted"] as const)(
    "does not use %s assistant text as final terminal text",
    async (stopReason) => {
      const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
      const assistant = assistantMessage(stopReason);
      const prepared = prepareEmbeddedRunTerminal({
        runParams: {
          admittedRunContext: createTestAdmittedRunContext("run-1"),
          sessionId: "session-1",
          runId: "run-1",
          workspaceDir: "/tmp/openclaw-test",
          prompt: "hi",
          trigger: "user",
          timeoutMs: 60_000,
        },
        attempt: attemptResult({
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
        }),
        currentAttemptCompletedAssistant: assistant,
        provider: "openai",
        model: "gpt-5.4",
        activeErrorContext: { provider: "openai", model: "gpt-5.4" },
        authProfileStore: { version: 1, profiles: {} },
        sessionIdUsed: "session-1",
        outerContextTokenMeta: {},
        usageAccumulator: createUsageAccumulator(),
        contextRecoveryState: createEmbeddedRunContextRecoveryState(),
        resolvedToolResultFormat: "markdown",
        terminalState: {
          outcome:
            stopReason === "aborted"
              ? { reason: "aborted", status: "error", stopReason }
              : { reason: "failed", status: "error", stopReason, error: "provider failed" },
          signalOwnedInterruption: false,
        },
      });

      expect(prepared.finalAssistantVisibleText).toBeUndefined();
      expect(prepared.finalAssistantRawText).toBeUndefined();
    },
  );

  it("uses the current completed assistant instead of stale session evidence", async () => {
    const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
    const finalText = "The requested update is complete.";
    const staleAssistant = {
      ...assistantMessage("toolUse"),
      content: [{ type: "toolCall" as const, id: "tool_1", name: "update_plan", arguments: {} }],
    };
    const currentAssistant = {
      ...assistantMessage("stop"),
      content: [{ type: "text" as const, text: finalText }],
      usage: {
        ...assistantMessage("stop").usage,
        input: 200,
        output: 20,
        totalTokens: 220,
      },
    };
    const prepared = prepareEmbeddedRunTerminal({
      runParams: {
        admittedRunContext: createTestAdmittedRunContext("run-current"),
        sessionId: "session-current",
        runId: "run-current",
        workspaceDir: "/tmp/openclaw-test",
        prompt: "hi",
        trigger: "user",
        timeoutMs: 60_000,
      },
      attempt: attemptResult({
        assistantTexts: ["Analysis...", finalText],
        toolMetas: [{ toolName: "update_plan" }],
        lastAssistant: staleAssistant,
        currentAttemptAssistant: currentAssistant,
        currentAttemptCompletedAssistant: currentAssistant,
      }),
      currentAttemptCompletedAssistant: currentAssistant,
      provider: "openai",
      model: "gpt-5.4",
      activeErrorContext: { provider: "openai", model: "gpt-5.4" },
      authProfileStore: { version: 1, profiles: {} },
      sessionIdUsed: "session-current",
      outerContextTokenMeta: {},
      usageAccumulator: createUsageAccumulator(),
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      resolvedToolResultFormat: "markdown",
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });

    expect(prepared.finalAssistantVisibleText).toBe(finalText);
    expect(prepared.finalAssistantRawText).toBe(finalText);
    expect(prepared.agentMeta.lastCallUsage).toMatchObject({ input: 200, output: 20, total: 220 });
  });

  it("recovers current final text and tool media after a prompt-timeout race", async () => {
    const completedText = "Completed answer block before the timeout.";
    const partialText = "Partial final response before the timeout.";
    const finalText = "Complete final response after the timeout.";
    const finalAssistant = {
      ...assistantMessage("stop"),
      content: [{ type: "text" as const, text: finalText }],
    };
    payloadMocks.buildEmbeddedRunPayloads.mockReturnValueOnce([
      { text: completedText },
      { text: partialText },
    ]);

    const prepared = await prepareAttempt({
      attempt: attemptResult({
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        assistantTexts: [completedText, partialText],
        toolMediaUrls: ["https://example.test/recovered-output.png"],
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        currentAttemptCompletedAssistant: finalAssistant,
      }),
      currentAttemptCompletedAssistant: finalAssistant,
      terminalState: {
        outcome: {
          reason: "hard_timeout",
          status: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
        },
        signalOwnedInterruption: false,
      },
    });

    expect(prepared.hasSuccessfulFinalAssistantAfterPromptTimeout).toBe(true);
    expect(prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout).toEqual([
      expect.objectContaining({
        mediaUrl: "https://example.test/recovered-output.png",
        text: completedText,
      }),
      { text: finalText },
    ]);
  });

  it("does not recover stale session text after the current prompt times out", async () => {
    const staleAssistant = {
      ...assistantMessage("stop"),
      content: [{ type: "text" as const, text: "Stale answer from the prior attempt." }],
    };

    const prepared = await prepareAttempt({
      attempt: attemptResult({
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        assistantTexts: [],
        lastAssistant: staleAssistant,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: undefined,
      }),
      currentAttemptCompletedAssistant: undefined,
      terminalState: {
        outcome: {
          reason: "hard_timeout",
          status: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
        },
        signalOwnedInterruption: false,
      },
    });

    expect(prepared.finalAssistantVisibleText).toBeUndefined();
    expect(prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout).toBeUndefined();
    expect(prepared.hasSuccessfulFinalAssistantAfterPromptTimeout).toBe(false);
  });

  it("uses the yielded assistant for paused-turn payload classification", async () => {
    const completedAssistant = assistantMessage("stop");
    const yieldedAssistant = {
      ...assistantMessage("aborted"),
      content: [
        { type: "toolCall" as const, id: "yield-1", name: "sessions_yield", arguments: {} },
      ],
    };
    const attempt = attemptResult({
      assistantTexts: [],
      lastAssistant: yieldedAssistant,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: completedAssistant,
      yieldDetected: true,
    });

    await prepareAttempt({
      attempt,
      currentAttemptCompletedAssistant: completedAssistant,
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });

    expect(payloadMocks.buildEmbeddedRunPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ lastAssistant: yieldedAssistant, currentAssistant: null }),
    );
  });
});

describe("prepareEmbeddedRunTerminal run stats", () => {
  type StatsInput = {
    attempt?: Partial<EmbeddedRunAttemptWithReceiptEvidence> & {
      terminalTurnId?: string;
    };
    assistantTurns?: number;
    bridgeCalls?: { search: number; describe: number; call: number };
    config?: unknown;
    provider?: string;
    model?: string;
    outerContextTokenMeta?: { contextTokens?: number };
    responseModel?: string;
    usage?: Partial<
      Pick<
        ReturnType<typeof createUsageAccumulator>,
        "input" | "output" | "cacheRead" | "cacheWrite" | "total"
      >
    >;
  };

  async function prepareStats(statsInput: StatsInput = {}) {
    const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
    const provider = statsInput.provider ?? "cost-test-provider";
    const model = statsInput.model ?? "cost-model";
    const assistant = {
      ...assistantMessage("stop"),
      provider,
      model,
      ...(statsInput.responseModel ? { responseModel: statsInput.responseModel } : {}),
    };
    const usageAccumulator = createUsageAccumulator();
    Object.assign(usageAccumulator, statsInput.usage);
    usageAccumulator.assistantTurns = statsInput.assistantTurns ?? 0;
    usageAccumulator.bridgeCalls = statsInput.bridgeCalls;
    return prepareEmbeddedRunTerminal({
      runParams: {
        admittedRunContext: createTestAdmittedRunContext("run-1"),
        sessionId: "session-1",
        runId: "run-1",
        workspaceDir: "/tmp/openclaw-test",
        prompt: "hi",
        trigger: "user",
        timeoutMs: 60_000,
        ...(statsInput.config ? { config: statsInput.config as never } : {}),
      },
      attempt: attemptResult({
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
        ...statsInput.attempt,
      }),
      currentAttemptCompletedAssistant: assistant,
      provider,
      model,
      activeErrorContext: { provider, model },
      authProfileStore: { version: 1, profiles: {} },
      sessionIdUsed: "session-1",
      outerContextTokenMeta: statsInput.outerContextTokenMeta ?? {},
      usageAccumulator,
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      resolvedToolResultFormat: "markdown",
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });
  }

  const COST_CONFIG = {
    models: {
      providers: {
        "cost-test-provider": {
          models: [
            {
              id: "cost-model",
              cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 4 },
            },
          ],
        },
      },
    },
  };

  it.each([
    { name: "engaged", codeModeEngaged: true, expected: true },
    { name: "not engaged", codeModeEngaged: false, expected: false },
    { name: "unreported (harness route)", codeModeEngaged: undefined, expected: false },
  ])("stamps codeModeEngaged when $name", async ({ codeModeEngaged, expected }) => {
    const prepared = await prepareStats({ attempt: { codeModeEngaged } });
    expect(prepared.agentMeta.codeModeEngaged).toBe(expected);
  });

  it("records whether the context window came from the harness or prepared resolution", async () => {
    const observed = await prepareStats({
      attempt: { contextTokens: 1_000_000, contextTokensSource: "runtime" },
      outerContextTokenMeta: { contextTokens: 272_000 },
    });
    expect(observed.agentMeta).toMatchObject({
      contextTokens: 1_000_000,
      contextTokensSource: "runtime",
    });

    const configured = await prepareStats({
      attempt: { contextTokens: 272_000, contextTokensSource: "runtime-configured" },
      outerContextTokenMeta: { contextTokens: 1_000_000 },
    });
    expect(configured.agentMeta).toMatchObject({
      contextTokens: 272_000,
      contextTokensSource: "runtime-configured",
    });

    const resolved = await prepareStats({
      outerContextTokenMeta: { contextTokens: 272_000 },
    });
    expect(resolved.agentMeta).toMatchObject({
      contextTokens: 272_000,
      contextTokensSource: "resolved",
    });
  });

  it("stamps assistantTurns from the run accumulator and omits zero", async () => {
    const counted = await prepareStats({ assistantTurns: 3 });
    expect(counted.agentMeta.assistantTurns).toBe(3);

    const empty = await prepareStats({ assistantTurns: 0 });
    expect(empty.agentMeta).not.toHaveProperty("assistantTurns");
  });

  it("stamps run-accumulated bridge call counts and omits them when absent", async () => {
    const withBridge = await prepareStats({
      bridgeCalls: { search: 2, describe: 1, call: 5 },
    });
    expect(withBridge.agentMeta.bridgeCalls).toEqual({ search: 2, describe: 1, call: 5 });

    const withoutBridge = await prepareStats({});
    expect(withoutBridge.agentMeta).not.toHaveProperty("bridgeCalls");
  });

  it("computes costUsd from accumulated usage including cache pricing", async () => {
    const prepared = await prepareStats({
      config: COST_CONFIG,
      usage: {
        input: 1_000_000,
        output: 500_000,
        cacheRead: 2_000_000,
        cacheWrite: 250_000,
        total: 3_750_000,
      },
    });
    // (1M*$1 + 0.5M*$2 + 2M*$0.5 + 0.25M*$4) per million tokens.
    expect(prepared.agentMeta.costUsd).toBeCloseTo(4, 10);
  });

  it("omits costUsd when the model has no cost data", async () => {
    const prepared = await prepareStats({
      provider: "no-cost-provider",
      model: "uncosted-model",
      config: COST_CONFIG,
      usage: { input: 1_000_000, output: 500_000, total: 1_500_000 },
    });
    expect(prepared.agentMeta).not.toHaveProperty("costUsd");
  });

  it("omits costUsd when the run reported no usage", async () => {
    const prepared = await prepareStats({ config: COST_CONFIG });
    expect(prepared.agentMeta).not.toHaveProperty("costUsd");
  });

  it("keeps response identity in the terminal receipt without replacing the run model", async () => {
    const prepared = await prepareStats({
      responseModel: "cost-model-rerouted",
      attempt: {
        terminalTurnId: "turn-7",
        toolMetas: [
          { toolName: "exec", isError: false },
          { toolName: "unknown" },
          { toolName: "write", isError: true },
          { toolName: "read", isError: false },
          { toolName: "exec", isError: false },
        ],
        successfulNestedToolNames: ["read", "zeta", "alpha", "Zeta", " exec ", "alpha", " "],
      },
    });

    expect(
      (prepared.agentMeta as { terminalReceipt?: Record<string, unknown> }).terminalReceipt,
    ).toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
      turnId: "turn-7",
      requested: { provider: "cost-test-provider", model: "cost-model" },
      effective: {
        provider: "cost-test-provider",
        model: "cost-model",
        responseModel: "cost-model-rerouted",
      },
      successfulToolNames: ["exec", "read", "Zeta", "alpha", "zeta"],
      rerouted: true,
    });
    expect(
      (prepared.agentMeta as { terminalReceipt?: Record<string, unknown> }).terminalReceipt,
    ).not.toHaveProperty("terminalDisposition");
    expect(prepared.agentMeta.model).toBe("cost-model");
    expect(prepared.reportedModelRef.model).toBe("cost-model");
  });
});
