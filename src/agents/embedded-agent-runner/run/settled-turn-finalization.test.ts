import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { SessionTranscriptWriterClaimReboundError } from "../../../config/sessions/transcript-write-context.js";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunContext,
} from "../../admitted-run-context.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS } from "./lane-runtime.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

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

let admittedRunContext: AdmittedRunContext;

function finalizationInput(attempt: ReturnType<typeof settledFailedAttempt>) {
  return createSettledFinalizationTestInput(attempt, admittedRunContext);
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

  it("keeps explicit silence terminal across required and optional settled turns", () => {
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
          allowEmptyAssistantReplyAsSilent: true,
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
    expect(request({ trigger: "user", terminalReplyExpectation: "required" })).toBeNull();
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
    ).toBeNull();
    expect(
      request({
        payloadsWithToolMedia: buildEmbeddedRunPayloads({
          assistantTexts: [],
          lastAssistant: assistant,
          lastToolError: attempt.lastToolError,
          sessionKey: "session:settled-policy",
        }),
      }),
    ).toContain(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
  });
});

describe("prepareTerminalWithSettledTurnFinalization", () => {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  beforeEach(async () => {
    backendMocks.runSettledFinalization.mockReset();
    transcriptMocks.appendAssistantMirrorMessageByIdentity.mockReset();
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "finalization-test");
    admittedRunContext = await admission.admit("embedded");
  });
  afterEach(() => {
    admission.close();
    vi.useRealTimers();
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

  it("preserves runtime context and model selection through isolated finalization", async () => {
    const runtimeModelSelection = { provider: "openai", model: "native-selected-model" };
    const attempt = {
      ...settledFailedAttempt(),
      agentHarnessId: "codex",
      runtimeModelSelection,
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
      provider: "host-finalizer",
      model: "summary-model",
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
      runtimeModelSelection,
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
      provider: "host-finalizer",
      model: "summary-model",
      runtimeModelSelection,
      credentialSource: { kind: "profile" },
      contextTokens: 1_000_000,
      contextTokensSource: "runtime",
    });
  });

  it("retries empty finalization with fresh controls and retires prior timeout and Stop callbacks", async () => {
    vi.useFakeTimers();
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    const factory = vi.mocked(input.finalization.createAttemptControls);
    const { close, ...retiredControls } = factory({ admittedRunContext });
    close();
    factory.mockClear();
    Object.assign(input.finalization.preparedAttempt, retiredControls, {
      abortSignal: AbortSignal.abort(new Error("original attempt timed out")),
    });
    const emptyAssistant = buildEmbeddedRunnerAssistant({ content: [] });
    const finalAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "The command completed successfully." }],
    });
    let firstAttempt: EmbeddedRunAttemptParams;
    backendMocks.runSettledFinalization
      .mockImplementationOnce(async (params: EmbeddedRunAttemptParams) => {
        firstAttempt = params;
        expect(params.abortSignal?.aborted).toBe(false);
        expect(params.onAttemptAbort).not.toBe(retiredControls.onAttemptAbort);
        expect(params.onAttemptTimeout).not.toBe(retiredControls.onAttemptTimeout);
        expect(params.onAttemptDeadlineChanged).not.toBe(retiredControls.onAttemptDeadlineChanged);
        params.onAttemptTimeout?.(new Error("first finalizer timed out while settling"));
        return { outcome: "empty", result: { assistant: emptyAssistant } };
      })
      .mockImplementationOnce(async (params: EmbeddedRunAttemptParams) => {
        expect(params.onAttemptAbort).not.toBe(firstAttempt.onAttemptAbort);
        expect(params.onAttemptTimeout).not.toBe(firstAttempt.onAttemptTimeout);
        expect(params.onAttemptDeadlineChanged).not.toBe(firstAttempt.onAttemptDeadlineChanged);
        firstAttempt.onAttemptAbort?.();
        firstAttempt.onAttemptTimeout?.(new Error("late timeout"));
        firstAttempt.onAttemptDeadlineChanged?.({ kind: "bounded", deadlineAtMs: Date.now() });
        await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS + 1);
        expect(params.abortSignal?.aborted).toBe(false);
        return { outcome: "answered", result: { assistant: finalAssistant } };
      });

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(backendMocks.runSettledFinalization.mock.calls).toEqual([
      [expect.objectContaining({ disableTools: true }), attempt, expect.anything()],
      [expect.objectContaining({ disableTools: true }), attempt, expect.anything()],
    ]);
    expect(result.finalizationOutcome).toBe("answered");
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: "The command completed successfully." }),
    ]);
    expect(result.prepared.agentMeta).toMatchObject({ assistantTurns: 3 });
    for (const controls of factory.mock.results) {
      if (controls.type === "return") {
        controls.value.onAttemptAbort();
        controls.value.onAttemptTimeout(new Error("late timeout after finalization"));
      }
    }
    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS + 1);
    expect(input.finalization.abortSignal.aborted).toBe(false);
  });

  it.each([
    { timeoutMs: 60_000, initialTimeoutMs: 60_000 },
    { timeoutMs: 0, initialTimeoutMs: MAX_TIMER_TIMEOUT_MS },
  ])(
    "seeds the normalized $timeoutMs budget when the finalizer publishes no deadline",
    async ({ timeoutMs, initialTimeoutMs }) => {
      const input = finalizationInput(settledFailedAttempt());
      input.finalization.preparedAttempt.timeoutMs = timeoutMs;
      backendMocks.runSettledFinalization.mockResolvedValueOnce({
        outcome: "answered",
        result: {
          assistant: buildEmbeddedRunnerAssistant({ content: [{ type: "text", text: "Done." }] }),
        },
      });

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(input.finalization.createAttemptControls).toHaveBeenCalledExactlyOnceWith({
        admittedRunContext: input.terminalBase.runParams.admittedRunContext,
        abortSignal: input.finalization.abortSignal,
        initialTimeoutMs,
      });
      expect(result.finalizationOutcome).toBe("answered");
    },
  );

  it("persists fallback with the queue signal after the original attempt aborts", async () => {
    const attempt = settledFailedAttempt();
    const emptyAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "" }],
    });
    backendMocks.runSettledFinalization.mockResolvedValue({
      outcome: "empty",
      result: { assistant: emptyAssistant, usage: emptyAssistant.usage },
    });

    const input = finalizationInput(attempt);
    input.finalization.preparedAttempt.abortSignal = AbortSignal.abort(
      new Error("original attempt timed out"),
    );
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
      signal: input.finalization.abortSignal,
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

  it("closes failed finalizer controls before delivering a host fallback", async () => {
    vi.useFakeTimers();
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    backendMocks.runSettledFinalization.mockImplementationOnce(
      async (params: EmbeddedRunAttemptParams) => {
        params.onAttemptTimeout?.(new Error("finalizer timeout"));
        throw new Error("finalizer failed");
      },
    );

    const result = await prepareTerminalWithSettledTurnFinalization(input);
    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS + 1);

    expect(input.finalization.abortSignal.aborted).toBe(false);
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

  it.each(["outer", "Stop"])(
    "preserves %s cancellation during finalization without a fallback",
    async (source) => {
      const attempt = settledFailedAttempt();
      const input = finalizationInput(attempt);
      const controller = new AbortController();
      input.finalization.abortSignal = AbortSignal.any([
        input.finalization.abortSignal,
        controller.signal,
      ]);
      backendMocks.runSettledFinalization.mockImplementationOnce(
        async (params: EmbeddedRunAttemptParams) => {
          if (source === "outer") {
            controller.abort(new Error("cancelled by user"));
          } else {
            params.onAttemptAbort?.();
          }
          params.abortSignal?.throwIfAborted();
          throw new Error("finalizer cancellation did not propagate");
        },
      );

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
      expect(input.finalization.abortSignal.aborted).toBe(true);
      expect(result.finalizationOutcome).toBe("failed");
      expect(result.attempt).toBe(attempt);
      expect(result.prepared.payloadsWithToolMedia?.[0]).toMatchObject({ isError: true });
      expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).not.toHaveBeenCalled();
    },
  );

  it("preserves cancellation while fallback transcript persistence is pending", async () => {
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    const controller = new AbortController();
    input.finalization.abortSignal = controller.signal;
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
