import { describe, expect, it } from "vitest";
import { completeEmbeddedAttemptResult, createMcpAttemptCarryover } from "./attempt-result.js";
import { buildTraceToolSummary, normalizeEmbeddedRunAttemptResult } from "./run-attempt-result.js";

function completeResult(params?: {
  successfulNestedToolNames?: string[];
  latestMcpAppChannelView?: { viewId: string };
  lastToolRecovery?: { toolName: string };
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
      getLastToolRecovery: () => params?.lastToolRecovery,
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
      terminal: { kind: "ok" },
      sessionIdUsed: "session-1",
      messagesSnapshot: [],
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

describe("attempt result projection", () => {
  it("projects the last recovered tool", () => {
    expect(completeResult({ lastToolRecovery: { toolName: "write" } }).lastToolRecovery).toEqual({
      toolName: "write",
    });
  });

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
    const carryover = createMcpAttemptCarryover();
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
