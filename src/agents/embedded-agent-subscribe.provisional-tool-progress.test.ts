import { afterEach, describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import * as agentEvents from "../infra/agent-events.js";
import { handleMessageUpdate } from "./embedded-agent-subscribe.handlers.messages.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import type { AgentMessage } from "./runtime/index.js";

function createContext(
  params: {
    onAgentEvent?: ReturnType<typeof vi.fn>;
    toolMetaById?: Map<string, unknown>;
  } = {},
): EmbeddedAgentSubscribeContext {
  return {
    params: {
      runId: "run-1",
      session: { id: "session-1" },
      ...(params.onAgentEvent ? { onAgentEvent: params.onAgentEvent } : {}),
    },
    state: {
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
      reasoningStreamOpen: false,
      streamReasoning: false,
      deltaBuffer: "",
      blockBuffer: "",
      partialBlockState: {
        thinking: false,
        final: false,
        inlineCode: createInlineCodeState(),
      },
      lastStreamedAssistant: undefined,
      lastStreamedAssistantCleaned: undefined,
      emittedAssistantUpdate: false,
      shouldEmitPartialReplies: true,
      blockReplyBreak: "text_end",
      assistantMessageIndex: 0,
      assistantTexts: [],
      toolMetaById: (params.toolMetaById ??
        new Map()) as EmbeddedAgentSubscribeContext["state"]["toolMetaById"],
      toolSummaryById: new Set(),
      itemActiveIds: new Set(),
      itemStartedCount: 0,
      itemCompletedCount: 0,
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    noteLastAssistant: vi.fn(),
    noteCompletedAssistant: vi.fn(),
    stripBlockTags: vi.fn((text: string) => text),
    consumePartialReplyDirectives: vi.fn(() => undefined),
    emitAssistantStreamData: vi.fn(),
    emitReasoningStream: vi.fn(),
    shouldEmitToolResult: () => false,
    emitToolSummary: vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    resetAssistantMessageState: vi.fn(),
    recordAssistantUsage: vi.fn(),
    commitAssistantUsage: vi.fn(),
  } as unknown as EmbeddedAgentSubscribeContext;
}

function writePartialMessage(params: {
  id: string;
  path?: string;
  content?: string;
}): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: params.id,
        name: "write",
        arguments: {
          ...(params.path ? { path: params.path } : {}),
          ...(params.content !== undefined ? { content: params.content } : {}),
        },
      },
    ],
    stopReason: "stop",
  } as AgentMessage;
}

describe("provisional mutation tool progress", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("emits start as soon as write tool name is known, before path appears", () => {
    const emitSpy = vi.spyOn(agentEvents, "emitAgentEvent").mockImplementation(() => undefined);
    const ctx = createContext();

    handleMessageUpdate(ctx, {
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-write-early",
            name: "write",
            arguments: { content: "partial…" },
          },
        ],
        stopReason: "stop",
      },
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0 },
    } as never);

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          phase: "start",
          name: "write",
          toolCallId: "call-write-early",
          args: { content: "partial…" },
        },
      }),
    );
  });

  it("emits start with path and content preview while write args stream", () => {
    const emitSpy = vi.spyOn(agentEvents, "emitAgentEvent").mockImplementation(() => undefined);
    const onAgentEvent = vi.fn();
    const ctx = createContext({ onAgentEvent });

    handleMessageUpdate(ctx, {
      type: "message_update",
      message: writePartialMessage({
        id: "call-write-1",
        path: "/tmp/foo.md",
        content: "hello world",
      }),
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "…" },
    } as never);

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        stream: "tool",
        data: {
          phase: "start",
          name: "write",
          toolCallId: "call-write-1",
          args: { path: "/tmp/foo.md", content: "hello world" },
        },
      }),
    );
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "tool",
        data: expect.objectContaining({
          phase: "start",
          args: { path: "/tmp/foo.md", content: "hello world" },
        }),
      }),
    );
  });

  it("throttles content updates and skips after real tool start", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T00:00:00.000Z"));
    const emitSpy = vi.spyOn(agentEvents, "emitAgentEvent").mockImplementation(() => undefined);
    const ctx = createContext();

    handleMessageUpdate(ctx, {
      type: "message_update",
      message: writePartialMessage({
        id: "call-write-2",
        path: "/repo/a.md",
        content: "a",
      }),
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0 },
    } as never);
    expect(emitSpy).toHaveBeenCalledTimes(1);

    handleMessageUpdate(ctx, {
      type: "message_update",
      message: writePartialMessage({
        id: "call-write-2",
        path: "/repo/a.md",
        content: "ab",
      }),
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0 },
    } as never);
    expect(emitSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(80);
    handleMessageUpdate(ctx, {
      type: "message_update",
      message: writePartialMessage({
        id: "call-write-2",
        path: "/repo/a.md",
        content: "abcd",
      }),
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0 },
    } as never);
    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(emitSpy.mock.calls[1]?.[0]?.data).toEqual({
      phase: "update",
      name: "write",
      toolCallId: "call-write-2",
      args: { path: "/repo/a.md", content: "abcd" },
    });

    ctx.state.toolMetaById.set("call-write-2", {
      instanceReplaySafe: true,
      replaySafe: true,
      mutatingAction: true,
    });
    vi.advanceTimersByTime(80);
    handleMessageUpdate(ctx, {
      type: "message_update",
      message: writePartialMessage({
        id: "call-write-2",
        path: "/repo/a.md",
        content: "abcdef",
      }),
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0 },
    } as never);
    expect(emitSpy).toHaveBeenCalledTimes(2);
  });
});
