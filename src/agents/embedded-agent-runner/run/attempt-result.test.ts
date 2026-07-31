import { describe, expect, it } from "vitest";
import { completeEmbeddedAttemptResult } from "./attempt-result.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function completeResult(params?: {
  latestMcpAppChannelView?: { viewId: string };
  clientToolCallSlots?: Array<{
    toolCallId: string;
    name: string;
    params?: Record<string, unknown>;
    completed: boolean;
  }>;
  pendingToolMediaReply?: { mediaUrls?: string[]; audioAsVoice?: boolean };
  toolMetas?: EmbeddedRunAttemptResult["toolMetas"];
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
      yieldDetected: false,
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
          {
            toolName: "exec",
            meta: "done",
            durationMs: 25,
            replaySafe: true,
            mutatingAction: true,
            fileTarget: { path: "result.txt" },
            sideEffectFree: false,
            codeModeHadTargetlessSideEffects: true,
            codeModeSuccessfulObservationFileTargets: [{ path: "facts.txt" }],
            codeModeSuccessfulAbsenceObservationFileTargets: [{ path: "old.txt" }],
            codeModeUnverifiedMutationFileTargets: [{ path: "result.txt", expected: "present" }],
            isError: true,
            asyncStarted: true,
            asyncTaskRunId: "run-1",
            asyncTaskId: "task-1",
          },
        ],
      }).toolMetas,
    ).toEqual([
      {
        toolName: "exec",
        meta: "done",
        durationMs: 25,
        replaySafe: true,
        mutatingAction: true,
        fileTarget: { path: "result.txt" },
        sideEffectFree: false,
        codeModeHadTargetlessSideEffects: true,
        codeModeSuccessfulObservationFileTargets: [{ path: "facts.txt" }],
        codeModeSuccessfulAbsenceObservationFileTargets: [{ path: "old.txt" }],
        codeModeUnverifiedMutationFileTargets: [{ path: "result.txt", expected: "present" }],
        isError: true,
        asyncStarted: true,
        asyncTaskRunId: "run-1",
        asyncTaskId: "task-1",
      },
    ]);
  });

  it("preserves native file verification ordering evidence", () => {
    expect(
      completeResult({
        toolMetas: [
          {
            toolName: "read",
            replaySafe: true,
            fileTarget: { path: "result.txt" },
            fileTargetVerified: true,
          },
        ],
      }).toolMetas,
    ).toEqual([
      {
        toolName: "read",
        meta: undefined,
        replaySafe: true,
        fileTarget: { path: "result.txt" },
        fileTargetVerified: true,
      },
    ]);
  });

  it("preserves native file mutation dispatch evidence", () => {
    expect(
      completeResult({
        toolMetas: [
          {
            toolName: "write",
            replaySafe: false,
            mutatingAction: true,
            fileTarget: { path: "result.txt" },
            fileMutationExecutionStarted: true,
            isError: true,
          },
        ],
      }).toolMetas,
    ).toEqual([
      {
        toolName: "write",
        meta: undefined,
        replaySafe: false,
        mutatingAction: true,
        fileTarget: { path: "result.txt" },
        fileMutationExecutionStarted: true,
        isError: true,
      },
    ]);
  });

  it("preserves native file absence verification evidence", () => {
    expect(
      completeResult({
        toolMetas: [
          {
            toolName: "read",
            replaySafe: true,
            fileTarget: { path: "old.txt" },
            fileTargetAbsent: true,
            isError: true,
          },
        ],
      }).toolMetas,
    ).toEqual([
      {
        toolName: "read",
        meta: undefined,
        replaySafe: true,
        fileTarget: { path: "old.txt" },
        fileTargetAbsent: true,
        isError: true,
      },
    ]);
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
