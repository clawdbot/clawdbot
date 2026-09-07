import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunContext,
} from "../../admitted-run-context.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";
import { isEmbeddedRunTerminalTimeout } from "./terminal-outcome.js";

const backendMocks = vi.hoisted(() => ({
  runSettledFinalization: vi.fn(),
  resolveRuntimeModelAttempt: vi.fn(() => undefined),
}));
const transcriptMocks = vi.hoisted(() => ({
  appendAssistantMirrorMessageByIdentity: vi.fn(),
}));

const SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT =
  "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";

vi.mock("./backend.js", () => ({
  resolveRuntimeModelAttempt: backendMocks.resolveRuntimeModelAttempt,
  runEmbeddedSettledTurnFinalizationWithBackend: backendMocks.runSettledFinalization,
}));
vi.mock("../../../plugin-sdk/session-transcript-runtime.js", () => ({
  appendAssistantMirrorMessageByIdentity: transcriptMocks.appendAssistantMirrorMessageByIdentity,
}));

/** A settled successful tool batch whose post-tool model stream hit the idle watchdog. */
function settledIdleTimeoutAttempt(): EmbeddedRunAttemptWithReceiptEvidence {
  const assistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "tool-write", name: "write", arguments: {} }],
  });
  const messagesSnapshot = [
    assistant,
    { role: "toolResult", toolCallId: "tool-write", toolName: "write", isError: false },
  ] as never;
  return {
    ...makeEmbeddedRunnerAttempt({
      terminal: { kind: "timeout", phase: "prompt", source: "idle" },
      sessionIdUsed: "session-settled",
      sessionFileUsed: "/tmp/session-settled.jsonl",
      assistantTexts: [],
      toolMetas: [{ toolName: "write", isError: false, replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      messagesSnapshot,
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      settledTurnFinalizationContext: { source: "openclaw-transcript", messages: messagesSnapshot },
      assistantTurns: 1,
    }),
    successfulNestedToolNames: [],
  };
}

let admittedRunContext: AdmittedRunContext;

describe("prepareTerminalWithSettledTurnFinalization after an idle prompt timeout", () => {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  beforeEach(async () => {
    backendMocks.runSettledFinalization.mockReset();
    transcriptMocks.appendAssistantMirrorMessageByIdentity.mockReset();
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "finalization-test");
    admittedRunContext = await admission.admit("embedded");
  });
  afterEach(() => {
    admission.close();
  });

  it("keeps the timeout authoritative when finalization stays empty", async () => {
    const attempt = settledIdleTimeoutAttempt();
    const emptyAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "" }],
    });
    backendMocks.runSettledFinalization.mockResolvedValue({
      outcome: "empty",
      result: { assistant: emptyAssistant, usage: emptyAssistant.usage },
    });

    const result = await prepareTerminalWithSettledTurnFinalization(
      createSettledFinalizationTestInput(attempt, admittedRunContext),
    );

    expect(backendMocks.runSettledFinalization).toHaveBeenCalledTimes(2);
    expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).not.toHaveBeenCalled();
    expect(result.finalizationOutcome).toBe("failed");
    expect(result.attempt).toBe(attempt);
    expect(isEmbeddedRunTerminalTimeout(result.terminalState.outcome)).toBe(true);
    expect(result.prepared.timedOutDuringPrompt).toBe(true);
    expect(result.prepared.payloadsWithToolMedia ?? []).not.toContainEqual(
      expect.objectContaining({ text: SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT }),
    );
  });

  it("keeps the timeout authoritative when finalization fails", async () => {
    const attempt = settledIdleTimeoutAttempt();
    backendMocks.runSettledFinalization.mockRejectedValueOnce(new Error("finalizer failed"));

    const result = await prepareTerminalWithSettledTurnFinalization(
      createSettledFinalizationTestInput(attempt, admittedRunContext),
    );

    expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
    expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).not.toHaveBeenCalled();
    expect(result.finalizationOutcome).toBe("failed");
    expect(result.attempt).toBe(attempt);
    expect(isEmbeddedRunTerminalTimeout(result.terminalState.outcome)).toBe(true);
    expect(result.prepared.timedOutDuringPrompt).toBe(true);
  });
});
