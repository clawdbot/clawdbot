import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  createFollowupRun,
  createMockTypingSignaler,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

function useClaudeCliFallback() {
  state.isCliProviderMock.mockReturnValue(true);
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
    result: await params.run("claude-cli", "claude-opus-4-6"),
    provider: "claude-cli",
    model: "claude-opus-4-6",
    attempts: [],
  }));
}

function createClaudeCliFollowupRun() {
  const followupRun = createFollowupRun();
  followupRun.run.provider = "claude-cli";
  followupRun.run.model = "claude-opus-4-6";
  return followupRun;
}

function createTurnParams(opts: GetReplyOptions, blockStreamingEnabled: boolean) {
  return {
    commandBody: "hi",
    followupRun: createClaudeCliFollowupRun(),
    sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
    opts,
    typingSignals: createMockTypingSignaler(),
    blockReplyPipeline: null,
    blockStreamingEnabled,
    resolvedBlockStreamingBreak: "message_end" as const,
    applyReplyToMode: <T>(payload: T) => payload,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => false,
    pendingToolTasks: new Set<Promise<void>>(),
    resetSessionAfterRoleOrderingConflict: async () => false,
    isHeartbeat: false,
    sessionKey: "main",
    getActiveSessionEntry: () => undefined,
    resolvedVerboseLevel: "off" as const,
  };
}

describe("executeAgentTurn: CLI durable commentary", () => {
  it("delivers completed CLI commentary through block streaming", async () => {
    useClaudeCliFallback();
    state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
      (params: { onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]> }) =>
        params.onBlockReply,
    );
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        expect(params.emitCommentaryText).toBe(true);
        const agentEvents = await import("../../infra/agent-events.js");
        agentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "item",
          data: {
            kind: "preamble",
            itemId: "commentary-durable-1",
            progressText: "The durable findings live here.",
          },
        });
        return { payloads: [{ text: "Short final wrap-up." }], meta: {} };
      },
    );

    const onBlockReply = vi.fn<NonNullable<GetReplyOptions["onBlockReply"]>>(async () => undefined);
    const onItemEvent = vi.fn<NonNullable<GetReplyOptions["onItemEvent"]>>(async () => undefined);
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createTurnParams(
        {
          onBlockReply,
          onItemEvent,
          commentaryProgressEnabled: false,
          progressPreambleEnabled: true,
        },
        true,
      ),
    );

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
        text: "The durable findings live here.",
      });
      expect(onItemEvent).toHaveBeenCalledExactlyOnceWith({
        itemId: "commentary-durable-1",
        kind: "preamble",
        progressText: "The durable findings live here.",
      });
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads).toEqual([{ text: "Short final wrap-up." }]);
    }
  });

  it("delivers commentary payloads without block streaming", async () => {
    useClaudeCliFallback();
    state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
      (params: { onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]> }) =>
        params.onBlockReply,
    );
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        expect(params.emitCommentaryText).toBe(true);
        const agentEvents = await import("../../infra/agent-events.js");
        agentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "item",
          data: {
            kind: "preamble",
            itemId: "commentary-payload-1",
            progressText: "A durable commentary update.",
          },
        });
        return { payloads: [{ text: "Final answer." }], meta: {} };
      },
    );

    const onBlockReply = vi.fn<NonNullable<GetReplyOptions["onBlockReply"]>>(async () => undefined);
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createTurnParams({ onBlockReply, commentaryPayloadsEnabled: true }, false),
    );

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
        text: "A durable commentary update.",
        isCommentary: true,
      });
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads).toEqual([{ text: "Final answer." }]);
    }
  });
});
