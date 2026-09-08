import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "../../../plugins/hooks.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { getCoreTtsAttemptResultMediaUrls } from "../../tools/tts-tool-result-provenance.js";
import { completeEmbeddedAttemptResult, createAttemptCarryover } from "./attempt-result.js";
import { buildTraceToolSummary, normalizeEmbeddedRunAttemptResult } from "./run-attempt-result.js";
import type { EmbeddedRunAttemptResult, EmbeddedRunAttemptTrajectoryRecorder } from "./types.js";

const TEST_OPERATIONAL_RUN_INSTANCE = { runId: "run-1" };

function createResultFixture(params?: {
  terminal?: EmbeddedRunAttemptResult["terminal"];
  currentAttemptCompletedAssistant?: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
  replyOptional?: boolean;
  trajectoryRecorder?: EmbeddedRunAttemptTrajectoryRecorder;
  messagesSnapshot?: EmbeddedRunAttemptResult["messagesSnapshot"];
  successfulNestedToolNames?: string[];
  latestMcpAppChannelView?: { viewId: string };
  clientToolCallSlots?: Array<{
    toolCallId: string;
    name: string;
    params?: Record<string, unknown>;
    completed: boolean;
  }>;
  pendingToolMediaReply?: { mediaUrls?: string[]; audioAsVoice?: boolean };
  toolAutoDeliveryMediaUrls?: string[];
  messagingToolSentMediaUrls?: string[];
  didSendViaMessagingTool?: boolean;
  yieldDetected?: boolean;
  yieldAcknowledgment?: string;
  assistantTexts?: readonly string[];
  toolMetas?: Array<{
    toolName: string;
    toolCallId?: string;
    meta?: string;
    replaySafe?: boolean;
    isError?: boolean;
    terminate?: boolean;
    asyncStarted?: boolean;
    asyncTaskRunId?: string;
    asyncTaskId?: string;
  }>;
}) {
  const state: Parameters<typeof completeEmbeddedAttemptResult>[0]["state"] = {
    beforeAgentRunBlockedBy: undefined,
    terminal: params?.terminal ?? { kind: "ok" },
    trajectoryEndRecorded: false,
  };
  const settled: Parameters<typeof completeEmbeddedAttemptResult>[1] = {
    promptError: null,
    promptErrorSource: null,
    timedOutDuringCompaction: false,
    compactionOccurredThisAttempt: false,
    sessionIdUsed: "session-1",
    messagesSnapshot: params?.messagesSnapshot ?? [],
    lastAssistant: undefined,
    currentAttemptAssistant: undefined,
    currentAttemptCompletedAssistant: params?.currentAttemptCompletedAssistant,
    successfulNestedToolNames: params?.successfulNestedToolNames ?? [],
    attemptUsage: undefined,
    lastCallUsage: undefined,
    promptCache: undefined,
  };
  const prompt: Parameters<typeof completeEmbeddedAttemptResult>[2] = {
    preflightRecovery: undefined,
    contextBudgetStatus: undefined,
    yieldAborted: false,
    sessionIdUsed: settled.sessionIdUsed,
    sessionFileUsed: undefined,
    messagesSnapshot: settled.messagesSnapshot,
  };
  const subscription = {
    assistantTexts: [...(params?.assistantTexts ?? [])],
    didSendDeterministicApprovalPrompt: () => false,
    didSendViaMessagingTool: () => params?.didSendViaMessagingTool ?? false,
    getAcceptedSessionSpawns: () => [],
    getAssistantTurnCount: () => 0,
    getCompactionCount: () => 0,
    getHeartbeatToolResponse: () => undefined,
    getItemLifecycle: () => undefined,
    getLastAssistantTextMessageIndex: () => undefined,
    getLastCompactionTokensAfter: () => undefined,
    getLastToolError: () => undefined,
    getLatestMcpAppChannelView: () => params?.latestMcpAppChannelView,
    getLatestMcpConnectAction: () => undefined,
    getMessagingToolSentMediaUrls: () => params?.messagingToolSentMediaUrls ?? [],
    getMessagingToolSentTargets: () => [],
    getMessagingToolSentTexts: () => [],
    getMessagingToolSourceReplyPayloads: () => [],
    getSourceReplyDelivered: () => undefined,
    getPendingToolMediaReply: () => params?.pendingToolMediaReply,
    getToolAutoDeliveryMediaUrls: () => params?.toolAutoDeliveryMediaUrls ?? [],
    getReplayState: () => ({ replayInvalid: false, hadPotentialSideEffects: false }),
    getSuccessfulCronAdds: () => 0,
    getVisibleBlockReplyCount: () => 0,
    hasToolMediaBlockReply: () => false,
    setTerminalLifecycleMeta: () => {},
    toolMetas: params?.toolMetas ?? [],
  };
  const hookRunner = createHookRunner({ hooks: [], typedHooks: [], plugins: [] });
  const input = {
    attempt: {
      runId: "run-1",
      admittedRunContext: { operationalRunInstance: TEST_OPERATIONAL_RUN_INSTANCE },
      sessionId: "session-1",
      provider: "test",
      modelId: "model",
      model: { api: "openai-responses" },
      trigger: "user",
      allowEmptyAssistantReplyAsSilent: params?.replyOptional,
      terminalReplyExpectation: params?.replyOptional ? "optional" : undefined,
    },
    state,
    diagnostics: { diagnosticTrace: { traceId: "trace-1", spanId: "span-1" } },
    setup: { sessionAgentId: "main" },
    lifecycle: {
      readYieldState: () => ({
        yieldDetected: params?.yieldDetected ?? false,
        yieldAcknowledgment: params?.yieldAcknowledgment,
      }),
    },
    prepared: {
      bootstrap: { bootstrapPromptWarning: {} },
      systemPrompt: { systemPromptReport: undefined },
      sessionRuntime: {
        agentSession: {
          clientToolCallSlots: params?.clientToolCallSlots ?? [],
          hasDeliveredSourceReply: () => false,
          hookRunner,
        },
        state: { promptCache: undefined },
        cacheTrace: null,
        trajectoryRecorder: params?.trajectoryRecorder,
        transport: { streamStrategy: "default" },
      },
    },
    preparedStreamRuntime: {
      stream: { subscription },
      cache: {},
    },
  };
  return { input, state, settled, prompt, hookRunner };
}

function completeResult(params?: Parameters<typeof createResultFixture>[0]) {
  const { input, settled, prompt } = createResultFixture(params);
  return completeEmbeddedAttemptResult(input as never, settled, prompt);
}

function settledToolMessages(): EmbeddedRunAttemptResult["messagesSnapshot"] {
  return [
    {
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read",
      isError: false,
      timestamp: 1,
      content: [{ type: "text", text: "file contents" }],
    },
  ];
}

describe("attempt result projection", () => {
  it("keeps the settled result snapshot when an output hook replaces live state", () => {
    const assistant = makeAssistantMessageFixture({ content: [{ type: "text", text: "settled" }] });
    const fixture = createResultFixture({ currentAttemptCompletedAssistant: assistant });
    fixture.settled.lastAssistant = assistant;
    fixture.prompt.finalPromptText = "settled prompt";
    const messages = fixture.prompt.messagesSnapshot;
    vi.spyOn(fixture.hookRunner, "hasHooks").mockReturnValue(true);
    const output = vi.spyOn(fixture.hookRunner, "runLlmOutput").mockImplementationOnce(async () => {
      fixture.state.terminal = { kind: "failed", source: "prompt", error: new Error("later") };
      fixture.settled.lastAssistant = undefined;
      fixture.settled.currentAttemptCompletedAssistant = undefined;
      fixture.settled.attemptUsage = { input: 100, output: 200 };
      fixture.prompt.finalPromptText = "later prompt";
      fixture.prompt.messagesSnapshot = [{ role: "user", content: "later", timestamp: 2 }];
      fixture.input.lifecycle.readYieldState = () => ({
        yieldDetected: true,
        yieldAcknowledgment: "later yield",
      });
    });

    const result = completeEmbeddedAttemptResult(
      fixture.input as never,
      fixture.settled,
      fixture.prompt,
    );

    expect(output).toHaveBeenCalledOnce();
    expect(fixture.state.terminal.kind).toBe("failed");
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(result.lastAssistant).toBe(assistant);
    expect(result.currentAttemptCompletedAssistant).toBe(assistant);
    expect(result.messagesSnapshot).toBe(messages);
    expect(result.finalPromptText).toBe("settled prompt");
    expect(result.attemptUsage).toBeUndefined();
    expect(result).toHaveProperty("yieldDetected", undefined);
    expect(result).toHaveProperty("yieldAcknowledgment", undefined);
    expect(result).not.toHaveProperty("beforeAgentFinalizeRevisionReason");
  });

  it("keeps current tool replay evidence separate from cumulative replay state", () => {
    const result = completeResult({ toolMetas: [{ toolName: "cron", replaySafe: false }] });

    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: false, replaySafe: true });
    expect(result.currentAttemptReplayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("does not turn an uncorroborated messaging flag into terminal output", () => {
    const recordEvent = vi.fn<EmbeddedRunAttemptTrajectoryRecorder["recordEvent"]>();
    const result = completeResult({
      didSendViaMessagingTool: true,
      trajectoryRecorder: { recordEvent, flush: async () => {} },
    });

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(recordEvent).toHaveBeenCalledWith(
      "session.ended",
      expect.objectContaining({ status: "error", terminalError: "non_deliverable_terminal_turn" }),
    );
  });

  it.each([
    {
      label: "a completed refusal",
      assistant: makeAssistantMessageFixture({
        content: [],
        diagnostics: [{ type: "provider_refusal", timestamp: 1, details: { category: "cyber" } }],
      }),
      expectedStatus: "error",
      terminalError: undefined,
    },
    {
      label: "a completed empty length stop",
      assistant: makeAssistantMessageFixture({
        content: [],
        stopReason: "length",
        errorMessage: undefined,
      }),
      expectedStatus: "error",
      terminalError: "non_deliverable_terminal_turn",
    },
    {
      label: "an actually empty optional turn",
      assistant: undefined,
      expectedStatus: "success",
      terminalError: undefined,
    },
  ])(
    "records $label after transcript projection",
    ({ assistant, expectedStatus, terminalError }) => {
      const recordEvent = vi.fn<EmbeddedRunAttemptTrajectoryRecorder["recordEvent"]>();
      const result = completeResult({
        currentAttemptCompletedAssistant: assistant,
        replyOptional: true,
        trajectoryRecorder: { recordEvent, flush: async () => {} },
      });

      expect(result.currentAttemptAssistant).toBeUndefined();
      expect(result.currentAttemptCompletedAssistant).toEqual(assistant);
      expect(recordEvent).toHaveBeenCalledWith(
        "session.ended",
        expect.objectContaining({ status: expectedStatus, terminalError }),
      );
    },
  );

  it.each([
    {
      label: "provider socket reset",
      source: "prompt" as const,
      error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      expected: true,
    },
    {
      label: "nested provider socket failure",
      source: "prompt" as const,
      error: new Error("provider request failed", {
        cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
      }),
      expected: true,
    },
    {
      label: "authentication failure",
      source: "prompt" as const,
      error: Object.assign(new Error("401 Unauthorized"), { status: 401 }),
      expected: false,
    },
    {
      label: "quota exhaustion",
      source: "prompt" as const,
      error: Object.assign(new Error("429 insufficient_quota"), { status: 429 }),
      expected: false,
    },
    {
      label: "policy denial",
      source: "prompt" as const,
      error: new Error("content policy violation"),
      expected: false,
    },
    {
      label: "security denial",
      source: "prompt" as const,
      error: Object.assign(new Error("403 Forbidden: security policy denied"), { status: 403 }),
      expected: false,
    },
    {
      label: "malformed provider response",
      source: "prompt" as const,
      error: new SyntaxError("Unexpected token in JSON response"),
      expected: false,
    },
    {
      label: "openai-completions truncated stream",
      source: "prompt" as const,
      error: new Error("Stream ended without finish_reason"),
      expected: true,
    },
    {
      label: "precheck socket failure",
      source: "precheck" as const,
      error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      expected: false,
    },
    {
      label: "compaction socket failure",
      source: "compaction" as const,
      error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      expected: false,
    },
    {
      label: "agent hook socket failure",
      source: "hook:before_agent_run" as const,
      error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      expected: false,
    },
  ])("limits settled-turn recovery after $label to $expected", ({ source, error, expected }) => {
    const result = completeResult({
      terminal: { kind: "failed", source, error },
      messagesSnapshot: settledToolMessages(),
    });

    expect(Boolean(result.settledTurnFinalizationContext)).toBe(expected);
  });

  it.each([
    {
      label: "an opaque WebSocket error",
      errorMessage: "WebSocket error",
      errorCode: "ERR_WEBSOCKET_TRANSPORT",
      expected: true,
    },
    {
      label: "a coded socket failure",
      errorMessage: "provider request failed",
      errorCode: "ECONNRESET",
      expected: true,
    },
    {
      label: "an authentication failure",
      errorMessage: "invalid API key",
      errorCode: undefined,
      expected: false,
    },
    {
      label: "an incomplete completions stream",
      errorMessage: "Stream ended without finish_reason",
      errorCode: undefined,
      expected: true,
    },
  ])(
    "captures settled-turn context from $label reported by the provider assistant=$expected",
    ({ errorMessage, errorCode, expected }) => {
      const result = completeResult({
        currentAttemptCompletedAssistant: makeAssistantMessageFixture({
          stopReason: "error",
          errorMessage,
          ...(errorCode ? { errorCode } : {}),
        }),
        messagesSnapshot: settledToolMessages(),
      });

      expect(Boolean(result.settledTurnFinalizationContext)).toBe(expected);
    },
  );

  it.each([
    {
      label: "only pre-tool commentary",
      assistantTexts: ["Checking the post-reboot state."],
      messagesSnapshot: [
        makeAssistantMessageFixture({
          stopReason: "toolUse",
          errorMessage: undefined,
          timestamp: 1,
          content: [
            { type: "text", text: "Checking the post-reboot state." },
            { type: "toolCall", id: "call-read", name: "read", arguments: {} },
          ],
        }),
        ...settledToolMessages(),
        makeAssistantMessageFixture({
          stopReason: "error",
          errorMessage: "Stream ended without finish_reason",
          timestamp: 3,
          content: [],
        }),
      ],
      expected: true,
    },
    {
      label: "unattributed visible text",
      assistantTexts: ["here is the answer"],
      messagesSnapshot: settledToolMessages(),
      expected: false,
    },
    {
      label: "post-tool authored text",
      assistantTexts: ["here is the answer"],
      messagesSnapshot: [
        ...settledToolMessages(),
        makeAssistantMessageFixture({
          stopReason: "stop",
          errorMessage: undefined,
          timestamp: 2,
          content: [{ type: "text", text: "here is the answer" }],
        }),
      ],
      expected: false,
    },
  ])(
    "keeps truncated-stream settled recovery for $label=$expected",
    ({ assistantTexts, messagesSnapshot, expected }) => {
      const result = completeResult({
        terminal: {
          kind: "failed",
          source: "prompt",
          error: new Error("Stream ended without finish_reason"),
        },
        assistantTexts,
        messagesSnapshot,
      });

      expect(Boolean(result.settledTurnFinalizationContext)).toBe(expected);
    },
  );

  it.each(["compaction", "tool_execution"] as const)(
    "does not authorize settled-turn finalization after a %s timeout observation",
    (timeoutObservation) => {
      const result = completeResult({
        terminal: {
          kind: "failed",
          source: "prompt",
          error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
          timeoutObservation,
        },
        messagesSnapshot: settledToolMessages(),
      });

      expect(result.settledTurnFinalizationContext).toBeUndefined();
    },
  );

  it.each(["compaction", "tool_execution"] as const)(
    "does not authorize assistant-reported finalization after a %s timeout observation",
    (phase) => {
      const result = completeResult({
        terminal: { kind: "timeout", phase, source: "observation" },
        currentAttemptCompletedAssistant: makeAssistantMessageFixture({
          stopReason: "error",
          errorMessage: "WebSocket error",
          errorCode: "ERR_WEBSOCKET_TRANSPORT",
        }),
        messagesSnapshot: settledToolMessages(),
      });

      expect(result.settledTurnFinalizationContext).toBeUndefined();
    },
  );

  it("carries the explicit yield acknowledgment separately from continuation context", () => {
    expect(
      completeResult({
        yieldDetected: true,
        yieldAcknowledgment: "Research started; results will follow.",
      }),
    ).toMatchObject({
      yieldDetected: true,
      yieldAcknowledgment: "Research started; results will follow.",
    });
  });

  it("counts each failed tool call in the trace summary", () => {
    expect(
      buildTraceToolSummary({
        toolMetas: [
          { toolName: "bash", meta: "exit=1", isError: true },
          { toolName: "bash", meta: "exit=2", isError: true },
          { toolName: "bash", meta: "exit=0" },
        ],
        fallbackHadFailure: false,
      }),
    ).toEqual({ calls: 3, tools: ["bash"], failures: 2 });
  });

  it("defaults missing replay metadata to replay-unsafe", () => {
    const attempt = completeResult();
    delete (attempt as Partial<typeof attempt>).replayMetadata;

    expect(normalizeEmbeddedRunAttemptResult(attempt as never).replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("carries the newest MCP presentation state across retry attempts", () => {
    const carryover = createAttemptCarryover();
    const first = {
      latestMcpAppChannelView: { viewId: "view-first" },
      latestMcpConnectAction: {
        serverName: "calendar",
        authorizationUrl: "https://auth.example/first",
      },
    };
    const retry: Parameters<typeof carryover.apply>[0] = {};
    const latest = {
      latestMcpAppChannelView: { viewId: "view-latest" },
      latestMcpConnectAction: {
        serverName: "calendar",
        authorizationUrl: "https://auth.example/latest",
      },
    };

    carryover.apply(first);
    carryover.apply(retry);
    carryover.apply(latest);

    expect(retry).toEqual(first);
    expect(latest.latestMcpAppChannelView.viewId).toBe("view-latest");
    expect(latest.latestMcpConnectAction.authorizationUrl).toBe("https://auth.example/latest");
  });

  it("keeps completed client tool calls in reserved source order", () => {
    expect(
      completeResult({
        clientToolCallSlots: [
          { toolCallId: "first", name: "search", params: { query: "one" }, completed: true },
          { toolCallId: "second", name: "search", completed: false },
          { toolCallId: "third", name: "fetch", params: { id: 3 }, completed: true },
        ],
      }).clientToolCalls,
    ).toEqual([
      { name: "search", params: { query: "one" } },
      { name: "fetch", params: { id: 3 } },
    ]);
  });

  it("filters invalid tool metadata and preserves terminal flags", () => {
    expect(
      completeResult({
        toolMetas: [
          { toolName: "", replaySafe: true },
          { toolName: "read", isError: false },
          {
            toolName: "exec",
            toolCallId: "tool-current",
            meta: "done",
            replaySafe: true,
            isError: true,
            terminate: true,
            asyncStarted: true,
            asyncTaskRunId: "run-1",
            asyncTaskId: "task-1",
          },
        ],
      }).toolMetas,
    ).toEqual([
      {
        toolName: "read",
        meta: undefined,
        replaySafe: false,
        isError: false,
      },
      {
        toolName: "exec",
        toolCallId: "tool-current",
        meta: "done",
        replaySafe: true,
        isError: true,
        terminate: true,
        asyncStarted: true,
        asyncTaskRunId: "run-1",
        asyncTaskId: "task-1",
      },
    ]);
  });

  it("projects successful nested tool names from settled attempt state", () => {
    expect(
      completeResult({ successfulNestedToolNames: ["read", "memory_search"] })
        .successfulNestedToolNames,
    ).toEqual(["read", "memory_search"]);
  });

  it("projects pending media and voice fields", () => {
    expect(completeResult().toolMediaUrls).toBeUndefined();
    expect(completeResult({ pendingToolMediaReply: { mediaUrls: [" "] } }).toolMediaUrls).toEqual([
      " ",
    ]);
    expect(
      completeResult({ pendingToolMediaReply: { mediaUrls: ["file:///tmp/result.png"] } })
        .toolMediaUrls,
    ).toEqual(["file:///tmp/result.png"]);
    expect(completeResult({ pendingToolMediaReply: { audioAsVoice: true } }).toolAudioAsVoice).toBe(
      true,
    );
    const autoDeliveryResult = completeResult({
      pendingToolMediaReply: { mediaUrls: ["/tmp/reply.opus"] },
      toolAutoDeliveryMediaUrls: ["/tmp/reply.opus"],
    });
    expect(
      getCoreTtsAttemptResultMediaUrls(
        autoDeliveryResult,
        autoDeliveryResult.toolMediaUrls,
        TEST_OPERATIONAL_RUN_INSTANCE,
      ),
    ).toEqual(["/tmp/reply.opus"]);
    const alreadySentResult = completeResult({
      pendingToolMediaReply: { mediaUrls: ["/tmp/reply.opus"] },
      toolAutoDeliveryMediaUrls: ["/tmp/reply.opus"],
      messagingToolSentMediaUrls: ["/tmp/reply.opus"],
    });
    expect(
      getCoreTtsAttemptResultMediaUrls(
        alreadySentResult,
        alreadySentResult.toolMediaUrls,
        TEST_OPERATIONAL_RUN_INSTANCE,
      ),
    ).toEqual([]);
  });

  it("projects the latest MCP App channel view without result data", () => {
    expect(
      completeResult({
        latestMcpAppChannelView: { viewId: "view-latest" },
      }).latestMcpAppChannelView,
    ).toEqual({ viewId: "view-latest" });
  });
});
