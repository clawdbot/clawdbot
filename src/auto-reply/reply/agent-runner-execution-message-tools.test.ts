import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  fallbackAttemptOptions,
  initialFallbackAttemptOptions,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { takeReplyOperationCompletionHandoff } from "./reply-completion-handoff.js";
import { createReplyOperation } from "./reply-run-registry.js";

const state = setupAgentRunnerExecutionTestState();

async function executeMessageToolOnlyAndTakeHandoff(result: Record<string, unknown>) {
  const key = `test-message-tool-handoff-${Date.now()}-${Math.random()}`;
  const sessionId = `session-${Math.random()}`;
  const operation = createReplyOperation({
    sessionKey: key,
    sessionId,
    resetTriggered: false,
  });
  const followupRun = createFollowupRun();
  followupRun.run.sessionKey = key;
  followupRun.run.sessionId = sessionId;
  followupRun.run.messageProvider = "telegram";
  followupRun.run.agentAccountId = "primary";
  followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
  followupRun.originatingChannel = "telegram";
  followupRun.originatingTo = "chat-1";
  followupRun.originatingAccountId = "primary";
  state.runEmbeddedAgentMock.mockResolvedValueOnce(result);

  try {
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const params = createMinimalRunAgentTurnParams({ followupRun, replyOperation: operation });
    params.sessionKey = key;
    await executeAgentTurn(params);
    operation.complete();
    const take = takeReplyOperationCompletionHandoff({
      operation,
      queueKey: key,
      admissionSessionId: sessionId,
    });
    return take.kind === "claimed" ? take.handoff : undefined;
  } finally {
    operation.complete();
  }
}

describe("executeAgentTurn: message tool progress", () => {
  it("mints a handoff only from an explicit completed source-final delivery", async () => {
    const handoff = await executeMessageToolOnlyAndTakeHandoff({
      payloads: [{ text: "NO_REPLY" }],
      messagingToolSentTargets: [
        {
          channel: "telegram",
          to: "chat-1",
          accountId: "primary",
          text: "Visible final reply",
          sourceReplyFinal: true,
        },
      ],
      meta: {},
    });

    expect(handoff).toMatchObject({
      kind: "completed_source_reply",
      deliveryTargetKey: expect.any(String),
    });
    expect(Object.isFrozen(handoff)).toBe(true);
  });

  it.each([
    {
      label: "foreign/unrelated message-tool send",
      result: {
        payloads: [{ text: "NO_REPLY" }],
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [
          { channel: "telegram", to: "chat-2", text: "Foreign send", sourceReplyFinal: false },
        ],
        meta: {},
      },
    },
    {
      label: "progress or partial source send",
      result: {
        payloads: [{ text: "NO_REPLY" }],
        didDeliverSourceReplyViaMessageTool: true,
        messagingToolSentTargets: [
          { channel: "telegram", to: "chat-1", text: "Partial", sourceReplyFinal: false },
        ],
        meta: {},
      },
    },
    {
      label: "failed run after a source-final marker",
      result: {
        payloads: [{ text: "NO_REPLY" }],
        messagingToolSentTargets: [
          { channel: "telegram", to: "chat-1", text: "Unsettled", sourceReplyFinal: true },
        ],
        meta: { error: { message: "provider crashed" } },
      },
    },
  ])("does not mint a handoff for $label", async ({ result }) => {
    await expect(executeMessageToolOnlyAndTakeHandoff(result)).resolves.toBeUndefined();
  });

  it("suppresses progress callbacks after message-tool-only delivery completes", async () => {
    let releaseItemEvent: (() => void) | undefined;
    const itemEventGate = new Promise<void>((resolve) => {
      releaseItemEvent = resolve;
    });
    let markItemEventStarted: (() => void) | undefined;
    const itemEventStarted = new Promise<void>((resolve) => {
      markItemEventStarted = resolve;
    });
    const onItemEvent = vi.fn(async () => {
      markItemEventStarted?.();
      await itemEventGate;
    });
    const onCommandOutput = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          phase: "start",
          name: "message",
          toolCallId: "message-1",
          args: {
            action: "send",
            message: "Visible reply",
          },
        },
      });
      const itemEventPromise = params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "tool-message-1",
          phase: "end",
          kind: "tool",
          title: "message",
          name: "message",
          toolCallId: "message-1",
          status: "completed",
        },
      });
      await itemEventStarted;
      await params.onAgentEvent?.({
        stream: "command_output",
        data: {
          itemId: "command:exec-1",
          phase: "end",
          title: "command false",
          toolCallId: "exec-1",
          name: "exec",
          output: "failed command output",
          status: "failed",
          exitCode: 1,
        },
      });
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          kind: "preamble",
          phase: "update",
          itemId: "commentary-1",
          progressText: "This must stay suppressed.",
        },
      });
      releaseItemEvent?.();
      await itemEventPromise;
      return {
        payloads: [{ text: "NO_REPLY" }],
        didDeliverSourceReplyViaMessageTool: true,
        meta: {},
      };
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "discord",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onItemEvent,
        onCommandOutput,
        progressPreambleEnabled: true,
      } satisfies InternalGetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "on",
    });

    expect(onItemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "message",
        phase: "end",
        status: "completed",
      }),
    );
    expect(onItemEvent).toHaveBeenCalledTimes(1);
    expect(onCommandOutput).not.toHaveBeenCalled();
    expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "tool_delivered",
        runStatus: "completed",
      }),
    );
  });

  it("records mute when a message-tool-only run completes without a send", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));

    expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "mute", runStatus: "completed" }),
    );
  });

  it("classifies a failed message-tool-only run separately from omission", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: { error: { message: "provider crashed" } },
    });
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));

    expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "mute", runStatus: "errored" }),
    );
  });

  it("preserves message-tool-only suppression across fallback candidates", async () => {
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    state.runEmbeddedAgentMock
      .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await params.onAgentEvent?.({
          stream: "tool",
          data: {
            phase: "start",
            name: "message",
            toolCallId: "message-1",
            args: { action: "send", message: "Visible reply" },
          },
        });
        await params.onAgentEvent?.({
          stream: "item",
          data: {
            itemId: "tool-message-1",
            phase: "end",
            kind: "tool",
            name: "message",
            toolCallId: "message-1",
            status: "completed",
          },
        });
        return { payloads: [], meta: {} };
      })
      .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await params.onAgentEvent?.({
          stream: "command_output",
          data: {
            itemId: "command:exec-1",
            phase: "end",
            name: "exec",
            output: "must stay suppressed",
            status: "completed",
            exitCode: 0,
          },
        });
        return { payloads: [{ text: "NO_REPLY" }], meta: {} };
      });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("anthropic", "primary", initialFallbackAttemptOptions(params));
      return {
        result: await params.run("openai", "fallback", fallbackAttemptOptions(params, "unknown")),
        provider: "openai",
        model: "fallback",
        attempts: [],
      };
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: { Provider: "discord", MessageSid: "msg" } as unknown as TemplateContext,
      opts: { onItemEvent, onCommandOutput } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "on",
    });

    expect(onItemEvent).toHaveBeenCalledTimes(1);
    expect(onCommandOutput).not.toHaveBeenCalled();
  });

  it("keeps opted-in progress callbacks active after message-tool-only delivery completes", async () => {
    const onToolStart = vi.fn();
    const onCommandOutput = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          phase: "start",
          name: "message",
          toolCallId: "message-1",
          args: {
            action: "send",
            message: "Visible reply",
          },
        },
      });
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "tool-message-1",
          phase: "end",
          kind: "tool",
          title: "message",
          name: "message",
          toolCallId: "message-1",
          status: "completed",
        },
      });
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          phase: "start",
          name: "bash",
          toolCallId: "bash-1",
          args: {
            command: "sleep 6",
          },
        },
      });
      await params.onAgentEvent?.({
        stream: "command_output",
        data: {
          itemId: "command:bash-1",
          phase: "end",
          title: "sleep 6",
          toolCallId: "bash-1",
          name: "bash",
          output: "done",
          status: "completed",
          exitCode: 0,
        },
      });
      return { payloads: [{ text: "NO_REPLY" }], meta: {} };
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "discord",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart,
        onCommandOutput,
      } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "on",
    });

    expect(onToolStart).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "bash",
        phase: "start",
        args: { command: "sleep 6" },
        detailMode: undefined,
      }),
    );
    expect(onCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "bash",
        output: "done",
        status: "completed",
      }),
    );
  });

  it("keeps progress callbacks active after message-tool-only reads", async () => {
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          phase: "start",
          name: "message",
          toolCallId: "message-read-1",
          args: {
            action: "read",
            threadId: "thread-1",
          },
        },
      });
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "tool-message-1",
          phase: "end",
          kind: "tool",
          title: "message",
          name: "message",
          toolCallId: "message-read-1",
          status: "completed",
        },
      });
      await params.onAgentEvent?.({
        stream: "command_output",
        data: {
          itemId: "command:exec-1",
          phase: "end",
          title: "command false",
          toolCallId: "exec-1",
          name: "exec",
          output: "failed command output",
          status: "failed",
          exitCode: 1,
        },
      });
      return { payloads: [{ text: "NO_REPLY" }], meta: {} };
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "discord",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onItemEvent,
        onCommandOutput,
      } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "on",
    });

    expect(onItemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "message",
        phase: "end",
        status: "completed",
      }),
    );
    expect(onCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "failed command output",
        status: "failed",
      }),
    );
  });
});
