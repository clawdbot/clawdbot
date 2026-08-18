import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

const backendMocks = vi.hoisted(() => ({
  runSettledFinalization: vi.fn(),
}));

vi.mock("./backend.js", () => ({
  runEmbeddedSettledTurnFinalizationWithBackend: backendMocks.runSettledFinalization,
}));

function settledFailedAttempt(): EmbeddedRunAttemptWithReceiptEvidence {
  const assistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [
      { type: "toolCall", id: "tool-read", name: "read", arguments: {} },
      { type: "toolCall", id: "tool-exec", name: "exec", arguments: {} },
    ],
  });
  const messagesSnapshot = [
    assistant,
    { role: "toolResult", toolCallId: "tool-read", toolName: "read", isError: false },
    { role: "toolResult", toolCallId: "tool-exec", toolName: "exec", isError: true },
  ] as never;
  const attempt = makeEmbeddedRunnerAttempt({
    sessionIdUsed: "session-settled",
    sessionFileUsed: "/tmp/session-settled.jsonl",
    assistantTexts: [],
    toolMetas: [
      { toolName: "read", isError: false, replaySafe: true },
      { toolName: "exec", isError: true, replaySafe: false },
    ],
    successfulCronAdds: 1,
    latestMcpAppChannelView: { viewId: "view-after-tools" },
    itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
    messagesSnapshot,
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    settledTurnFinalizationContext: { source: "openclaw-transcript", messages: messagesSnapshot },
    lastToolError: {
      toolName: "exec",
      error: "post-processing error",
      errorCode: "SYSTEM_RUN_DENIED",
    },
    codeModeEngaged: true,
    assistantTurns: 1,
    bridgeCalls: { search: 1, describe: 2, call: 3 },
  });
  return { ...attempt, successfulNestedToolNames: ["memory_search"] };
}

function finalizationInput(attempt: ReturnType<typeof settledFailedAttempt>) {
  const usageAccumulator = createUsageAccumulator();
  usageAccumulator.assistantTurns = 1;
  usageAccumulator.bridgeCalls = { search: 1, describe: 2, call: 3 };
  return {
    initial: {
      attempt,
      attemptAssistant: attempt.currentAttemptAssistant,
      currentAttemptCompletedAssistant: undefined,
      sessionIdUsed: attempt.sessionIdUsed,
      sessionFileUsed: attempt.sessionFileUsed,
      terminalState: resolveEmbeddedRunAttemptTerminalState({
        attempt,
        assistant: attempt.currentAttemptAssistant,
      }),
      attemptCompactionCount: 0,
    },
    terminalBase: {
      runParams: {
        admittedRunContext: createTestAdmittedRunContext("run-settled"),
        sessionId: "session-settled",
        runId: "run-settled",
        workspaceDir: "/tmp/openclaw-test",
        prompt: "finish the task",
        trigger: "cron",
        terminalReplyExpectation: "required",
        timeoutMs: 60_000,
        sourceReplyDeliveryMode: "message_tool_only",
      },
      provider: "openai",
      model: "gpt-5.6-luna",
      activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
      authProfileStore: { version: 1, profiles: {} },
      outerContextTokenMeta: {},
      usageAccumulator,
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      resolvedToolResultFormat: "markdown",
    },
    lastRunPromptUsage: undefined,
    finalization: {
      preparedAttempt: {
        runId: "run-settled",
        sessionId: "session-settled",
        workspaceDir: "/tmp/openclaw-test",
        prompt: "finish the task",
        timeoutMs: 60_000,
      },
      harness: {
        id: "test-harness",
        label: "Test harness",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        finalizeSettledTurn: vi.fn(),
      },
      modelApi: "openai-responses",
      executionContract: undefined,
      hasTerminalToolPresentation: false,
      noteLaneTaskProgress: vi.fn(),
    },
  } as unknown as Parameters<typeof prepareTerminalWithSettledTurnFinalization>[0];
}

describe("prepareTerminalWithSettledTurnFinalization", () => {
  beforeEach(() => {
    backendMocks.runSettledFinalization.mockReset();
  });

  it("replaces a settled failed-tool warning with failure-honest final output", async () => {
    const attempt = settledFailedAttempt();
    const finalAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "The exec tool failed: post-processing error." }],
    });
    backendMocks.runSettledFinalization.mockResolvedValueOnce({
      outcome: "answered",
      result: {
        assistant: finalAssistant,
        usage: finalAssistant.usage,
        diagnosticTrace: { traceId: "trace-final", spanId: "span-final" },
      },
    });

    const result = await prepareTerminalWithSettledTurnFinalization(finalizationInput(attempt));

    expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
    const [preparedAttempt, settledAttempt] =
      backendMocks.runSettledFinalization.mock.calls[0] ?? [];
    expect(preparedAttempt).toMatchObject({
      operation: "settled-tool-finalization",
      disableTools: true,
      skipPreparedUserTurnMessage: true,
      suppressNextUserMessagePersistence: true,
      initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
    });
    expect(settledAttempt).toBe(attempt);
    expect(result.finalizationOutcome).toBe("answered");
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: "The exec tool failed: post-processing error." }),
    ]);
    expect(getReplyPayloadMetadata(result.prepared.payloadsWithToolMedia?.[0] ?? {})).toMatchObject(
      {
        deliverDespiteSourceReplySuppression: true,
      },
    );
    expect(result.attempt).toMatchObject({
      latestMcpAppChannelView: { viewId: "view-after-tools" },
      successfulCronAdds: 1,
      successfulNestedToolNames: ["memory_search"],
      codeModeEngaged: true,
      itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    expect(result.prepared.agentMeta).toMatchObject({
      codeModeEngaged: true,
      assistantTurns: 2,
      bridgeCalls: { search: 1, describe: 2, call: 3 },
    });
    expect(result.prepared.failureSignal).toEqual({
      kind: "execution_denied",
      source: "tool",
      toolName: "exec",
      code: "SYSTEM_RUN_DENIED",
      message: "post-processing error",
      fatalForCron: true,
    });
  });

  it("preserves the settled runtime context window through isolated finalization", async () => {
    const attempt = {
      ...settledFailedAttempt(),
      agentHarnessId: "codex",
      contextTokens: 1_000_000,
      contextTokensSource: "runtime" as const,
    };
    const input = finalizationInput(attempt);
    input.terminalBase.outerContextTokenMeta = { contextTokens: 272_000 };
    input.finalization.preparedAttempt.agentHarnessId = "codex";
    const finalAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "The exec tool failed: post-processing error." }],
    });
    backendMocks.runSettledFinalization.mockResolvedValueOnce({
      outcome: "answered",
      result: {
        assistant: finalAssistant,
        usage: finalAssistant.usage,
        diagnosticTrace: { traceId: "trace-final", spanId: "span-final" },
      },
    });

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(result.attempt).toMatchObject({
      agentHarnessId: "codex",
      contextTokens: 1_000_000,
      contextTokensSource: "runtime",
    });
    expect(result.prepared.agentMeta).toMatchObject({
      agentHarnessId: "codex",
      contextTokens: 1_000_000,
      contextTokensSource: "runtime",
    });
  });

  it("fails closed and preserves the initial terminal preparation", async () => {
    const attempt = settledFailedAttempt();
    backendMocks.runSettledFinalization.mockRejectedValueOnce(new Error("finalizer failed"));

    const result = await prepareTerminalWithSettledTurnFinalization(finalizationInput(attempt));

    expect(result.finalizationOutcome).toBe("failed");
    expect(result.attempt).toBe(attempt);
    expect(result.prepared.payloadsWithToolMedia?.[0]).toMatchObject({ isError: true });
  });
});
