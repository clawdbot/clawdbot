import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const backend = vi.hoisted(() => ({ finalize: vi.fn() }));
vi.mock("./backend.js", () => ({
  resolveRuntimeModelAttempt: () => undefined,
  runEmbeddedSettledTurnFinalizationWithBackend: backend.finalize,
}));
vi.mock("../../../plugin-sdk/session-transcript-runtime.js", () => ({
  appendAssistantMirrorMessageByIdentity: vi.fn(),
}));

function providerFailedAttempt(): EmbeddedRunAttemptResult {
  const toolAssistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "call-write", name: "write", arguments: {} }],
  });
  const assistant = buildEmbeddedRunnerAssistant({
    stopReason: "error",
    errorMessage: "503 upstream connection refused",
  });
  const messagesSnapshot: EmbeddedRunAttemptResult["messagesSnapshot"] = [
    { role: "user", content: "Write the note", timestamp: 0 },
    toolAssistant,
    {
      role: "toolResult",
      toolCallId: "call-write",
      toolName: "write",
      content: [{ type: "text", text: "Note saved" }],
      isError: false,
      timestamp: 1,
    },
    assistant,
  ];
  return makeEmbeddedRunnerAttempt({
    terminal: { kind: "failed", source: "prompt", error: new Error(assistant.errorMessage) },
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    messagesSnapshot,
    toolMetas: [{ toolCallId: "call-write", toolName: "write", isError: false, replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    settledTurnFinalizationContext: {
      source: "openclaw-transcript",
      messages: Object.freeze([...messagesSnapshot]),
    },
  });
}

describe("prepared provider errors after settled tools", () => {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  let input: Parameters<typeof prepareTerminalWithSettledTurnFinalization>[0];
  beforeEach(async () => {
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "finalization-test");
    const attempt = providerFailedAttempt();
    input = createSettledFinalizationTestInput(attempt, await admission.admit("embedded"));
    input.initial.currentAttemptCompletedAssistant = attempt.currentAttemptCompletedAssistant;
    input.terminalBase.runParams.trigger = "user";
    backend.finalize.mockReset().mockResolvedValue({
      outcome: "answered",
      result: {
        assistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "Note saved." }],
        }),
      },
    });
  });
  afterEach(() => admission.close());

  it("replaces the generated provider error with one isolated final answer", async () => {
    const prepared = prepareEmbeddedRunTerminal({ ...input.terminalBase, ...input.initial });
    expect(prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("connection refused"),
      }),
    ]);

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(result.finalizationOutcome).toBe("answered");
    expect(backend.finalize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        disableTools: true,
        operation: "settled-tool-finalization",
        skipPreparedUserTurnMessage: true,
        suppressNextUserMessagePersistence: true,
      }),
      input.initial.attempt,
      input.finalization.harness,
    );
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: "Note saved." }),
    ]);
    expect(result.prepared.payloadsWithToolMedia?.[0]?.isError).not.toBe(true);
    expect(input.initial.attempt.replayMetadata.replaySafe).toBe(false);
  });

  it.each([
    { name: "missing recovery context", change: { settledTurnFinalizationContext: undefined } },
    {
      name: "authored assistant output",
      change: { assistantTexts: ["The note is already saved."] },
    },
    { name: "intentional silence", change: { assistantTexts: ["NO_REPLY"] } },
    {
      name: "unfinished tool",
      change: { itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 } },
    },
    {
      name: "asynchronous tool",
      change: { toolMetas: [{ toolName: "write", asyncStarted: true }] },
    },
    {
      name: "delivered reply",
      change: { didSendViaMessagingTool: true, messagingToolSentTexts: ["Note saved."] },
    },
    { name: "delivered media", change: { hasToolMediaBlockReply: true } },
    { name: "pending media", change: { toolMediaUrls: ["/tmp/note.png"] } },
    { name: "cancellation", change: { terminal: { kind: "aborted", source: "external" } } },
    {
      name: "non-transient provider error",
      change: {
        terminal: { kind: "failed", source: "prompt", error: new Error("invalid api key") },
        settledTurnFinalizationContext: undefined,
      },
    },
  ] satisfies Array<{ name: string; change: Partial<EmbeddedRunAttemptResult> }>)(
    "preserves $name instead of finalizing",
    async ({ change }) => {
      Object.assign(input.initial.attempt, change);
      input.initial.terminalState = resolveEmbeddedRunAttemptTerminalState({
        attempt: input.initial.attempt,
        assistant: input.initial.attempt.currentAttemptAssistant,
      });
      const result = await prepareTerminalWithSettledTurnFinalization(input);
      expect(result.finalizationOutcome).toBe("not-attempted");
      expect(backend.finalize).not.toHaveBeenCalled();
      expect(result.attempt).toBe(input.initial.attempt);
    },
  );

  it("keeps the failure-honest fallback when the isolated finalizer fails", async () => {
    backend.finalize.mockRejectedValueOnce(new Error("final provider request failed"));
    const result = await prepareTerminalWithSettledTurnFinalization(input);
    expect(backend.finalize).toHaveBeenCalledOnce();
    expect(result.finalizationOutcome).toBe("failed");
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({
        text: "The tool run finished, but no final summary was produced. I did not repeat any completed actions.",
      }),
    ]);
    expect(result.attempt.toolMetas).toBe(input.initial.attempt.toolMetas);
  });

  it("preserves a structured provider refusal even with stale transient context", async () => {
    const assistant = input.initial.currentAttemptCompletedAssistant;
    if (!assistant) {
      throw new Error("Missing failed assistant");
    }
    assistant.diagnostics = [
      { type: "provider_refusal", timestamp: 0, details: { provider: "openai" } },
    ];
    const result = await prepareTerminalWithSettledTurnFinalization(input);
    expect(result.finalizationOutcome).toBe("not-attempted");
    expect(backend.finalize).not.toHaveBeenCalled();
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("refused this request"),
      }),
    ]);
  });

  it("preserves a cron tool-authored silent outcome after discounting the error", async () => {
    input.terminalBase.runParams.trigger = "cron";
    const resultMessage = input.initial.attempt.messagesSnapshot.find(
      (message) => message.role === "toolResult",
    );
    if (!resultMessage || resultMessage.role !== "toolResult") {
      throw new Error("Missing settled tool result");
    }
    resultMessage.content = [{ type: "text", text: "NO_REPLY" }];
    const result = await prepareTerminalWithSettledTurnFinalization(input);
    expect(result.finalizationOutcome).toBe("not-attempted");
    expect(backend.finalize).not.toHaveBeenCalled();
  });

  it.each(["unmarked error", "structured tool error", "tool presentation"])(
    "preserves %s alongside the generated provider error",
    (kind) => {
      const prepared = prepareEmbeddedRunTerminal({ ...input.terminalBase, ...input.initial });
      const request = resolveSettledTurnFinalizationRequest({
        runParams: input.terminalBase.runParams,
        attempt: input.initial.attempt,
        activeErrorContext: input.terminalBase.activeErrorContext,
        modelApi: input.finalization.modelApi,
        executionContract: input.finalization.executionContract,
        payloadsWithToolMedia: [
          ...(prepared.payloadsWithToolMedia ?? []),
          ...(kind === "tool presentation"
            ? []
            : [
                {
                  text: "Explicit error",
                  isError: true,
                  ...(kind === "structured tool error" ? { channelData: { explicit: true } } : {}),
                },
              ]),
        ],
        hasTerminalToolPresentation: kind === "tool presentation",
        terminalState: input.initial.terminalState,
        settledTurnFinalizationAvailable: true,
      });
      expect(request).toBeNull();
    },
  );
});
