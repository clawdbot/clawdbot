import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: message tool progress", () => {
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
        stream: "assistant",
        data: {
          phase: "commentary",
          itemId: "commentary-1",
          text: "This must stay suppressed.",
        },
      });
      releaseItemEvent?.();
      await itemEventPromise;
      return { payloads: [{ text: "NO_REPLY" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    await runAgentTurnWithFallback({
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
      await params.run("anthropic", "primary");
      return {
        result: await params.run("openai", "fallback"),
        provider: "openai",
        model: "fallback",
        attempts: [],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    await runAgentTurnWithFallback({
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    await runAgentTurnWithFallback({
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    await runAgentTurnWithFallback({
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
