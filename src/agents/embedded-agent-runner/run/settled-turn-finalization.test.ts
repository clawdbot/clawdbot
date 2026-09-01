import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { SessionTranscriptWriterClaimReboundError } from "../../../config/sessions/transcript-write-context.js";
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
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";

const backendMocks = vi.hoisted(() => ({
  runSettledFinalization: vi.fn(),
  resolveRuntimeModelAttempt: vi.fn(
    (runtimePlan?: {
      resolvedRef?: { provider?: string; modelId?: string };
      auth?: { credentialSource?: unknown };
    }) =>
      runtimePlan?.resolvedRef?.provider &&
      runtimePlan.resolvedRef.modelId &&
      runtimePlan.auth?.credentialSource
        ? {
            provider: runtimePlan.resolvedRef.provider,
            model: runtimePlan.resolvedRef.modelId,
            credentialSource: runtimePlan.auth.credentialSource,
          }
        : undefined,
  ),
}));
const transcriptMocks = vi.hoisted(() => ({
  appendAssistantMirrorMessageByIdentity: vi.fn(),
}));

const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.";

const SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT =
  "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";

vi.mock("./backend.js", () => ({
  resolveRuntimeModelAttempt: backendMocks.resolveRuntimeModelAttempt,
  runEmbeddedSettledTurnFinalizationWithBackend: backendMocks.runSettledFinalization,
}));
vi.mock("../../../plugin-sdk/session-transcript-runtime.js", () => ({
  appendAssistantMirrorMessageByIdentity: transcriptMocks.appendAssistantMirrorMessageByIdentity,
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
    terminal: {
      kind: "failed",
      source: "compaction",
      error: new Error("native context compaction failed"),
    },
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

describe("resolveSettledTurnFinalizationRequest", () => {
  it("requests isolated finalization only for a required settled-tool turn", () => {
    const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text: "" }] });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      toolMetas: [{ toolName: "write", meta: "path=note.txt", replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
    const request = (terminalReplyExpectation: "required" | "optional") =>
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:settled",
          runId: "run:settled",
          terminalReplyExpectation,
        } as never,
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: [],
        hasTerminalToolPresentation: false,
        terminalState,
        settledTurnFinalizationAvailable: true,
      });

    expect(request("required")).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(request("optional")).toBeNull();
    expect(
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:settled-heartbeat",
          runId: "run:settled-heartbeat",
          trigger: "heartbeat",
        } as never,
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: [],
        hasTerminalToolPresentation: false,
        terminalState,
        settledTurnFinalizationAvailable: true,
      }),
    ).toBeNull();
  });

  it("keeps explicit silence terminal only for reply-optional settled turns", () => {
    const toolUseAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-1", name: "write", arguments: {} }],
    });
    const silentAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "stop",
      content: [{ type: "text", text: SILENT_REPLY_TOKEN }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [SILENT_REPLY_TOKEN],
      toolMetas: [{ toolName: "write", toolCallId: "tool-1", replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      messagesSnapshot: [
        { role: "user", content: [{ type: "text", text: "[OpenClaw heartbeat poll]" }] },
        toolUseAssistant,
        { role: "toolResult", toolCallId: "tool-1", toolName: "write", isError: false },
        silentAssistant,
      ] as never,
      lastAssistant: silentAssistant,
      currentAttemptAssistant: silentAssistant,
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });

    const request = (runParams: {
      trigger: "heartbeat" | "user";
      terminalReplyExpectation?: "required";
    }) =>
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:settled-silent",
          runId: "run:settled-silent",
          ...runParams,
        } as never,
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: [],
        hasTerminalToolPresentation: false,
        terminalState: resolveEmbeddedRunAttemptTerminalState({
          attempt,
          assistant: silentAssistant,
        }),
        settledTurnFinalizationAvailable: true,
      });

    expect(request({ trigger: "heartbeat" })).toBeNull();
    expect(request({ trigger: "user", terminalReplyExpectation: "required" })).toBe(
      SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
    );
  });

  it("requires an available finalizer and no visible structured error", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-1", name: "exec", arguments: {} }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [{ toolName: "exec", isError: true, replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      messagesSnapshot: [
        assistant,
        { role: "toolResult", toolCallId: "tool-1", toolName: "exec", isError: true } as never,
      ],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      lastToolError: { toolName: "exec", error: "post-processing error" },
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
    const request = (overrides: {
      payloadsWithToolMedia?: Parameters<
        typeof resolveSettledTurnFinalizationRequest
      >[0]["payloadsWithToolMedia"];
      settledTurnFinalizationAvailable?: boolean;
    }) =>
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:settled-policy",
          runId: "run:settled-policy",
          trigger: "user",
          terminalReplyExpectation: "required",
        } as never,
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: overrides.payloadsWithToolMedia ?? [],
        hasTerminalToolPresentation: false,
        terminalState,
        settledTurnFinalizationAvailable: overrides.settledTurnFinalizationAvailable ?? true,
      });

    expect(
      request({
        payloadsWithToolMedia: [
          {
            text: "Review the failed operation.",
            isError: true,
            channelData: { structuredError: true },
          },
        ],
      }),
    ).toBeNull();
    expect(request({ settledTurnFinalizationAvailable: false })).toBeNull();
    expect(
      request({ payloadsWithToolMedia: [{ text: "⚠️ 🛠️ Exec failed", isError: true }] }),
    ).toContain(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
  });
});

describe("prepareTerminalWithSettledTurnFinalization", () => {
  beforeEach(() => {
    backendMocks.runSettledFinalization.mockReset();
    transcriptMocks.appendAssistantMirrorMessageByIdentity.mockReset();
  });

  it.each([false, true])(
    "finalizes an empty post-tool turn only when media was not delivered (delivered: %s)",
    async (hasToolMediaBlockReply) => {
      const assistant = buildEmbeddedRunnerAssistant({ content: [] });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        toolMetas: [{ toolName: "tts", isError: false, replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        hasToolMediaBlockReply,
      });
      backendMocks.runSettledFinalization.mockResolvedValueOnce({
        outcome: "answered",
        result: {
          assistant: buildEmbeddedRunnerAssistant({
            content: [{ type: "text", text: "The tool run finished." }],
          }),
        },
      });

      const result = await prepareTerminalWithSettledTurnFinalization(finalizationInput(attempt));

      if (hasToolMediaBlockReply) {
        expect(backendMocks.runSettledFinalization).not.toHaveBeenCalled();
        expect(result.finalizationOutcome).toBe("not-attempted");
        expect(result.attempt).toBe(attempt);
        expect(result.prepared.payloadsWithToolMedia).toEqual([]);
      } else {
        expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
        expect(result.finalizationOutcome).toBe("answered");
        expect(result.prepared.payloadsWithToolMedia).toEqual([
          expect.objectContaining({ text: "The tool run finished." }),
        ]);
      }
    },
  );

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
    input.finalization.preparedAttempt.runtimePlan = {
      resolvedRef: { provider: "openai", modelId: "gpt-5.6-luna" },
      auth: { credentialSource: { kind: "profile" } },
    } as never;
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
      modelAttempt: {
        provider: "openai",
        model: "gpt-5.6-luna",
        credentialSource: { kind: "profile" },
      },
      contextTokens: 1_000_000,
      contextTokensSource: "runtime",
    });
    expect(result.prepared.agentMeta).toMatchObject({
      agentHarnessId: "codex",
      credentialSource: { kind: "profile" },
      contextTokens: 1_000_000,
      contextTokensSource: "runtime",
    });
  });

  it("retries an empty tool-free finalization once", async () => {
    const attempt = settledFailedAttempt();
    const emptyAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "" }],
    });
    const finalAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "The command completed successfully." }],
    });
    backendMocks.runSettledFinalization
      .mockResolvedValueOnce({
        outcome: "empty",
        result: { assistant: emptyAssistant, usage: emptyAssistant.usage },
      })
      .mockResolvedValueOnce({
        outcome: "answered",
        result: { assistant: finalAssistant, usage: finalAssistant.usage },
      });

    const result = await prepareTerminalWithSettledTurnFinalization(finalizationInput(attempt));

    expect(backendMocks.runSettledFinalization).toHaveBeenCalledTimes(2);
    expect(backendMocks.runSettledFinalization.mock.calls).toEqual([
      [expect.objectContaining({ disableTools: true }), attempt, expect.anything()],
      [expect.objectContaining({ disableTools: true }), attempt, expect.anything()],
    ]);
    expect(result.finalizationOutcome).toBe("answered");
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: "The command completed successfully." }),
    ]);
    expect(result.prepared.agentMeta).toMatchObject({ assistantTurns: 3 });
  });

  it("delivers a host fallback after two empty tool-free finalization attempts", async () => {
    const attempt = settledFailedAttempt();
    const emptyAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "" }],
    });
    backendMocks.runSettledFinalization.mockResolvedValue({
      outcome: "empty",
      result: { assistant: emptyAssistant, usage: emptyAssistant.usage },
    });

    const input = finalizationInput(attempt);
    input.finalization.preparedAttempt.sessionKey = "agent:main:settled";
    input.finalization.preparedAttempt.agentId = "main";
    input.finalization.preparedAttempt.sessionTarget = {
      agentId: "main",
      expectedLifecycleRevision: "revision-a",
      expectedWriterRunId: "run-settled",
      sessionId: "session-settled",
      sessionKey: "agent:main:settled",
      storePath: "/tmp/sessions.json",
    } as never;
    transcriptMocks.appendAssistantMirrorMessageByIdentity.mockResolvedValueOnce({
      ok: true,
      messageId: "fallback-message",
    });

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(backendMocks.runSettledFinalization).toHaveBeenCalledTimes(2);
    expect(result.finalizationOutcome).toBe("completed-empty");
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT }),
    ]);
    expect(result.prepared.payloadsWithToolMedia?.[0]?.isError).not.toBe(true);
    expect(getReplyPayloadMetadata(result.prepared.payloadsWithToolMedia?.[0] ?? {})).toMatchObject(
      {
        assistantTranscriptIdempotencyKey: "run-settled:settled-finalization-fallback",
        assistantTranscriptOwned: true,
        deliverDespiteSourceReplySuppression: true,
        sessionWriterDeliveryAuthority: {
          agentId: "main",
          expectedLifecycleRevision: "revision-a",
          expectedSessionId: "session-settled",
          expectedWriterRunId: "run-settled",
          sessionKey: "agent:main:settled",
          storePath: "/tmp/sessions.json",
        },
      },
    );
    expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).toHaveBeenCalledWith({
      agentId: "main",
      config: undefined,
      expectedLifecycleRevision: "revision-a",
      expectedWriterRunId: "run-settled",
      idempotencyKey: "run-settled:settled-finalization-fallback",
      sessionId: "session-settled",
      sessionKey: "agent:main:settled",
      storePath: "/tmp/sessions.json",
      text: SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT,
    });
    expect(result.attempt).toMatchObject({
      assistantTexts: [SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT],
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      toolMetas: attempt.toolMetas,
    });
    expect(result.prepared.agentMeta).toMatchObject({ assistantTurns: 3 });
  });

  it("preserves exhausted silent helper failure without synthesizing a fallback", async () => {
    const attempt = settledFailedAttempt();
    const emptyAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "" }],
    });
    backendMocks.runSettledFinalization.mockResolvedValue({
      outcome: "empty",
      result: { assistant: emptyAssistant, usage: emptyAssistant.usage },
    });
    const input = finalizationInput(attempt);
    input.finalization.preparedAttempt.silentExpected = true;

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(backendMocks.runSettledFinalization).toHaveBeenCalledTimes(2);
    expect(result.finalizationOutcome).toBe("completed-empty");
    expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).not.toHaveBeenCalled();
    expect(result.attempt.assistantTexts).toEqual([""]);
    expect(result.attempt.toolMetas).toBe(attempt.toolMetas);
    expect(result.prepared.payloadsWithToolMedia).not.toEqual([
      expect.objectContaining({ text: SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT }),
    ]);
  });

  it("delivers a host fallback when isolated finalization fails", async () => {
    const attempt = settledFailedAttempt();
    backendMocks.runSettledFinalization.mockRejectedValueOnce(new Error("finalizer failed"));

    const result = await prepareTerminalWithSettledTurnFinalization(finalizationInput(attempt));

    expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
    expect(result.finalizationOutcome).toBe("failed");
    expect(result.attempt).not.toBe(attempt);
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT }),
    ]);
    expect(result.prepared.payloadsWithToolMedia?.[0]?.isError).not.toBe(true);
    expect(result.prepared.failureSignal).toEqual({
      kind: "execution_denied",
      source: "tool",
      toolName: "exec",
      code: "SYSTEM_RUN_DENIED",
      message: "post-processing error",
      fatalForCron: true,
    });
    expect(result.attempt).toMatchObject({
      assistantTexts: [SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT],
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      toolMetas: attempt.toolMetas,
    });
  });

  it.each([false, true])(
    "uses the settled tool-batch identity for command-only fallback (context unavailable: %s)",
    async (unavailable) => {
      const assistant = buildEmbeddedRunnerAssistant({
        model: "gpt-5.6-luna",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "command-1", name: "exec", arguments: {} }],
      });
      const messagesSnapshot: EmbeddedRunAttemptWithReceiptEvidence["messagesSnapshot"] = [
        { role: "user", content: "Run the command.", timestamp: 1 },
        assistant,
        {
          role: "toolResult",
          toolCallId: "command-1",
          toolName: "exec",
          content: [{ type: "text", text: "done" }],
          isError: false,
          timestamp: 3,
        },
      ];
      const attempt = {
        ...makeEmbeddedRunnerAttempt({
          terminal: {
            kind: "failed",
            source: "prompt",
            error: new Error("The provider is overloaded"),
          },
          sessionIdUsed: "session-settled",
          sessionFileUsed: "/tmp/session-settled.jsonl",
          messagesSnapshot,
          toolMetas: [
            { toolName: "exec", toolCallId: "command-1", isError: false, replaySafe: false },
          ],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
          replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
          currentAttemptAssistant: undefined,
          lastAssistant: undefined,
          settledTurnFinalizationContext: unavailable
            ? { source: "unavailable" }
            : { source: "openclaw-transcript", messages: messagesSnapshot },
        }),
        successfulNestedToolNames: [],
      };
      const input = finalizationInput(attempt);
      input.terminalBase.runParams.trigger = "user";
      backendMocks.runSettledFinalization.mockRejectedValueOnce(new Error("finalizer failed"));

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
      expect(result.finalizationOutcome).toBe("failed");
      expect(result.prepared.payloadsWithToolMedia).toEqual([
        expect.objectContaining({ text: SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT }),
      ]);
      expect(result.prepared.payloadsWithToolMedia?.[0]?.isError).not.toBe(true);
      expect(result.prepared.failureSignal).toBeUndefined();
      expect(result.attempt.currentAttemptAssistant).toMatchObject({
        provider: assistant.provider,
        model: assistant.model,
      });
    },
  );

  it("preserves an explicit cancellation instead of delivering a fallback", async () => {
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    const controller = new AbortController();
    controller.abort(new Error("cancelled by user"));
    input.finalization.preparedAttempt.abortSignal = controller.signal;
    backendMocks.runSettledFinalization.mockRejectedValueOnce(new Error("finalizer cancelled"));

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
    expect(result.finalizationOutcome).toBe("failed");
    expect(result.attempt).toBe(attempt);
    expect(result.prepared.payloadsWithToolMedia?.[0]).toMatchObject({ isError: true });
  });

  it("preserves cancellation while fallback transcript persistence is pending", async () => {
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    const controller = new AbortController();
    input.finalization.preparedAttempt.abortSignal = controller.signal;
    input.finalization.preparedAttempt.sessionKey = "agent:main:settled";
    input.finalization.preparedAttempt.agentId = "main";
    input.finalization.preparedAttempt.sessionTarget = {
      agentId: "main",
      sessionId: "session-settled",
      sessionKey: "agent:main:settled",
      storePath: "/tmp/sessions.json",
    } as never;
    const emptyAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "" }],
    });
    backendMocks.runSettledFinalization.mockResolvedValue({
      outcome: "empty",
      result: { assistant: emptyAssistant, usage: emptyAssistant.usage },
    });

    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    transcriptMocks.appendAssistantMirrorMessageByIdentity.mockImplementationOnce(
      async (params: { signal?: AbortSignal }) => {
        markAppendStarted();
        await appendRelease;
        return params.signal?.aborted
          ? { ok: false, reason: "cancelled", code: "blocked" }
          : { ok: true, messageId: "fallback-message" };
      },
    );

    const resultPromise = prepareTerminalWithSettledTurnFinalization(input);
    await appendStarted;
    controller.abort(new Error("cancelled by user"));
    releaseAppend();
    const result = await resultPromise;

    expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(result.finalizationOutcome).toBe("failed");
    expect(result.attempt).toBe(attempt);
    expect(result.prepared.payloadsWithToolMedia).not.toEqual([
      expect.objectContaining({ text: SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT }),
    ]);
  });

  it("does not construct a fallback after its transcript writer is superseded", async () => {
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    input.finalization.preparedAttempt.sessionKey = "agent:main:settled";
    input.finalization.preparedAttempt.agentId = "main";
    input.finalization.preparedAttempt.sessionTarget = {
      agentId: "main",
      expectedLifecycleRevision: "revision-a",
      expectedWriterRunId: "run-settled",
      sessionId: "session-settled",
      sessionKey: "agent:main:settled",
      storePath: "/tmp/sessions.json",
    } as never;
    const emptyAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "" }],
    });
    backendMocks.runSettledFinalization.mockResolvedValue({
      outcome: "empty",
      result: { assistant: emptyAssistant, usage: emptyAssistant.usage },
    });
    transcriptMocks.appendAssistantMirrorMessageByIdentity.mockRejectedValueOnce(
      new SessionTranscriptWriterClaimReboundError(),
    );

    await expect(prepareTerminalWithSettledTurnFinalization(input)).rejects.toBeInstanceOf(
      SessionTranscriptWriterClaimReboundError,
    );
    expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).toHaveBeenCalledOnce();
  });

  it("uses a fresh session's committed writer fence for fallback persistence", async () => {
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    input.finalization.preparedAttempt.sessionKey = "agent:main:settled";
    input.finalization.preparedAttempt.agentId = "main";
    input.finalization.preparedAttempt.sessionTarget = {
      agentId: "main",
      sessionId: "session-settled",
      sessionKey: "agent:main:settled",
      storePath: "/tmp/sessions.json",
    } as never;
    Object.assign(input.finalization, {
      sessionWriterFence: {
        expectedLifecycleRevision: "revision-committed",
        expectedWriterRunId: "run-settled",
      },
    });
    const emptyAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "" }],
    });
    backendMocks.runSettledFinalization.mockResolvedValue({
      outcome: "empty",
      result: { assistant: emptyAssistant, usage: emptyAssistant.usage },
    });
    transcriptMocks.appendAssistantMirrorMessageByIdentity.mockResolvedValueOnce({
      ok: false,
      code: "blocked",
      reason: "writer replaced after the initial transcript commit",
    });

    await expect(prepareTerminalWithSettledTurnFinalization(input)).rejects.toBeInstanceOf(
      SessionTranscriptWriterClaimReboundError,
    );
    expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedLifecycleRevision: "revision-committed",
        expectedWriterRunId: "run-settled",
      }),
    );
  });

  it("does not construct a fallback after its fenced session entry is removed", async () => {
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    input.finalization.preparedAttempt.sessionKey = "agent:main:settled";
    input.finalization.preparedAttempt.agentId = "main";
    input.finalization.preparedAttempt.sessionTarget = {
      agentId: "main",
      expectedLifecycleRevision: "revision-a",
      expectedWriterRunId: "run-settled",
      sessionId: "session-settled",
      sessionKey: "agent:main:settled",
      storePath: "/tmp/sessions.json",
    } as never;
    const emptyAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "" }],
    });
    backendMocks.runSettledFinalization.mockResolvedValue({
      outcome: "empty",
      result: { assistant: emptyAssistant, usage: emptyAssistant.usage },
    });
    transcriptMocks.appendAssistantMirrorMessageByIdentity.mockResolvedValueOnce({
      ok: false,
      code: "blocked",
      reason: "missing active session",
    });

    await expect(prepareTerminalWithSettledTurnFinalization(input)).rejects.toBeInstanceOf(
      SessionTranscriptWriterClaimReboundError,
    );
    expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).toHaveBeenCalledOnce();
  });
});
