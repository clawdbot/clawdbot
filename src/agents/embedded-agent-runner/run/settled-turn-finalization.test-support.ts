import { vi } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import type { AdmittedRunContext } from "../../admitted-run-context.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

export function createSettledFinalizationTestInput(
  attempt: EmbeddedRunAttemptWithReceiptEvidence,
  admittedRunContext: AdmittedRunContext,
) {
  let lifecycleGeneration = getAgentEventLifecycleGeneration();
  const laneController = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => ({
      admittedRunContext,
      sessionFile: "/tmp/session-settled.jsonl",
      sessionId: "session-settled",
      runId: "run-settled",
      workspaceDir: "/tmp/openclaw-test",
      prompt: "finish the task",
      timeoutMs: 60_000,
    }),
    globalLane: "settled-finalization-global",
    sessionLane: "settled-finalization-session",
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    setLifecycleGeneration: (value) => {
      lifecycleGeneration = value;
    },
    setParams: () => {},
  });
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
        admittedRunContext,
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
        admittedRunContext,
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
      createAttemptControls: vi.fn(laneController.createAttemptControls),
      abortSignal: laneController.abortSignal,
    },
  } as unknown as Parameters<typeof prepareTerminalWithSettledTurnFinalization>[0];
}
