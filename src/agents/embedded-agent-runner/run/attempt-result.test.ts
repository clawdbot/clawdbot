import { describe, expect, it } from "vitest";
import { completeEmbeddedAttemptResult, createAttemptCarryover } from "./attempt-result.js";
import { buildTraceToolSummary, normalizeEmbeddedRunAttemptResult } from "./run-attempt-result.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function completeResult(params?: {
  terminal?: EmbeddedRunAttemptResult["terminal"];
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
  yieldDetected?: boolean;
  yieldAcknowledgment?: string;
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
  return completeEmbeddedAttemptResult({
    attempt: {
      runId: "run-1",
      sessionId: "session-1",
      provider: "test",
      modelId: "model",
      model: { api: "openai-responses" },
      trigger: "user",
    } as never,
    subscription: {
      assistantTexts: [],
      didSendDeterministicApprovalPrompt: () => false,
      didSendViaMessagingTool: () => false,
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
      getMessagingToolSentMediaUrls: () => [],
      getMessagingToolSentTargets: () => [],
      getMessagingToolSentTexts: () => [],
      getMessagingToolSourceReplyPayloads: () => [],
      getPendingToolMediaReply: () => params?.pendingToolMediaReply,
      getReplayState: () => ({ replayInvalid: false, hadPotentialSideEffects: false }),
      getSuccessfulCronAdds: () => [],
      getVisibleBlockReplyCount: () => 0,
      hasToolMediaBlockReply: () => false,
      setTerminalLifecycleMeta: () => {},
      toolMetas: params?.toolMetas ?? [],
    } as never,
    state: {
      terminal: params?.terminal ?? { kind: "ok" },
      sessionIdUsed: "session-1",
      messagesSnapshot: params?.messagesSnapshot ?? [],
      successfulNestedToolNames: params?.successfulNestedToolNames,
      yieldDetected: params?.yieldDetected ?? false,
      yieldAcknowledgment: params?.yieldAcknowledgment,
      didDeliverSourceReplyViaMessageTool: false,
      diagnosticTrace: { traceId: "trace-1", spanId: "span-1" },
    } as never,
    clientToolCallSlots: params?.clientToolCallSlots ?? [],
    hookRunner: null,
    hookAgentId: "main",
    bootstrapPromptWarning: {},
    cache: {
      observabilityEnabled: false,
      trace: null,
      break: null,
      changesForTurn: null,
      streamStrategy: "default",
    },
  });
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
  });

  it("projects the latest MCP App channel view without result data", () => {
    expect(
      completeResult({
        latestMcpAppChannelView: { viewId: "view-latest" },
      }).latestMcpAppChannelView,
    ).toEqual({ viewId: "view-latest" });
  });
});
