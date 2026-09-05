import { vi } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import type { AdmittedRunContext } from "../../admitted-run-context.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export function createSettledProviderFailureAttempt(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  const messages =
    overrides.messagesSnapshot ??
    ([
      { role: "user", content: "Write the note", timestamp: 0 },
      buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-write", name: "write", arguments: {} }],
      }),
      {
        role: "toolResult",
        toolCallId: "call-write",
        toolName: "write",
        content: [{ type: "text", text: "Note saved" }],
        isError: false,
        timestamp: 1,
      },
      buildEmbeddedRunnerAssistant({
        stopReason: "error",
        errorMessage: "503 upstream connection refused",
      }),
    ] satisfies EmbeddedRunAttemptResult["messagesSnapshot"]);
  const assistant = messages.at(-1);
  if (assistant?.role !== "assistant") {
    throw new Error("Expected a failed provider response after the tool batch");
  }
  return makeEmbeddedRunnerAttempt({
    terminal: {
      kind: "failed",
      source: "prompt",
      error: Object.assign(new Error(assistant.errorMessage), { code: assistant.errorCode }),
    },
    sessionIdUsed: "session-settled",
    messagesSnapshot: messages,
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    toolMetas: [{ toolCallId: "call-write", toolName: "write", isError: false, replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    settledTurnFinalizationContext: {
      source: "openclaw-transcript",
      messages: Object.freeze([...messages]),
    },
    ...overrides,
  });
}

export function createSettledFinalizationTestInput(
  attempt: EmbeddedRunAttemptWithReceiptEvidence,
  admittedRunContext: AdmittedRunContext,
) {
  const runParams = {
    admittedRunContext,
    sessionId: "session-settled",
    runId: "run-settled",
    workspaceDir: "/tmp/openclaw-test",
    prompt: "finish the task",
    timeoutMs: 60_000,
  };
  let lifecycleGeneration = getAgentEventLifecycleGeneration();
  const laneController = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => ({ ...runParams, sessionFile: "/tmp/session-settled.jsonl" }),
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
      currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
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
        ...runParams,
        trigger: "cron",
        terminalReplyExpectation: "required",
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
      preparedAttempt: { ...runParams },
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
