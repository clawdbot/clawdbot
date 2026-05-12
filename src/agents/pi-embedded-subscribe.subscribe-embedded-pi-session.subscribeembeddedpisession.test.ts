import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import * as agentEvents from "../infra/agent-events.js";
import {
  THINKING_TAG_CASES,
  createSubscribedSessionHarness,
  createStubSessionHarness,
  emitAssistantLifecycleErrorAndEnd,
  emitMessageStartAndEndForAssistantText,
  expectSingleAgentEventText,
  extractAgentEventPayloads,
  findLifecycleErrorAgentEvent,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";
import { makeZeroUsageSnapshot } from "./usage.js";

describe("subscribeEmbeddedPiSession", () => {
  async function flushBlockReplyCallbacks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function createAgentEventHarness(options?: { runId?: string; sessionKey?: string }) {
    const { session, emit } = createStubSessionHarness();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: options?.runId ?? "run",
      onAgentEvent,
      sessionKey: options?.sessionKey,
    });

    return { emit, onAgentEvent };
  }

  function createToolErrorHarness(runId: string) {
    const { session, emit } = createStubSessionHarness();
    const subscription = subscribeEmbeddedPiSession({
      session,
      runId,
      sessionKey: "test-session",
    });

    return { emit, subscription };
  }

  function createSubscribedHarness(
    options: Omit<Parameters<typeof subscribeEmbeddedPiSession>[0], "session">,
  ) {
    const { session, emit } = createStubSessionHarness();
    subscribeEmbeddedPiSession({
      session,
      ...options,
    });
    return { emit };
  }

  function emitAssistantTextDelta(
    emit: (evt: unknown) => void,
    delta: string,
    message: Record<string, unknown> = { role: "assistant" },
  ) {
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        delta,
      },
    });
  }

  function createWriteFailureHarness(params: {
    runId: string;
    path: string;
    content: string;
  }): ReturnType<typeof createToolErrorHarness> {
    const harness = createToolErrorHarness(params.runId);
    emitToolRun({
      emit: harness.emit,
      toolName: "write",
      toolCallId: "w1",
      args: { path: params.path, content: params.content },
      isError: true,
      result: { error: "disk full" },
    });
    expect(harness.subscription.getLastToolError()?.toolName).toBe("write");
    return harness;
  }

  function emitToolRun(params: {
    emit: (evt: unknown) => void;
    toolName: string;
    toolCallId: string;
    args?: Record<string, unknown>;
    isError: boolean;
    result: unknown;
  }): void {
    params.emit({
      type: "tool_execution_start",
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      args: params.args,
    });
    params.emit({
      type: "tool_execution_end",
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      isError: params.isError,
      result: params.result,
    });
  }

  function findBlockReplyPayload(
    onBlockReply: { mock: { calls: unknown[][] } },
    text: string,
  ): { mediaUrls?: unknown } | undefined {
    return onBlockReply.mock.calls
      .map((call) => call[0] as { text?: unknown; mediaUrls?: unknown })
      .find((payload) => payload.text === text);
  }

  function expectBlockReplyPayload(
    onBlockReply: { mock: { calls: unknown[][] } },
    expected: { text: string; mediaUrls?: string[] },
  ): void {
    const payload = findBlockReplyPayload(onBlockReply, expected.text);
    if (!payload) {
      throw new Error(`Expected block reply text: ${expected.text}`);
    }
    if (expected.mediaUrls !== undefined) {
      expect(payload.mediaUrls).toStrictEqual(expected.mediaUrls);
    }
  }

  function expectLifecyclePayload(
    payloads: Array<Record<string, unknown>>,
    expected: { phase: string; livenessState: string; replayInvalid: boolean },
  ): void {
    const payload = payloads.find(
      (item) =>
        item.phase === expected.phase &&
        item.livenessState === expected.livenessState &&
        item.replayInvalid === expected.replayInvalid,
    );
    if (!payload) {
      throw new Error(`Expected lifecycle payload for phase ${expected.phase}`);
    }
  }

  it("captures usage from completions timings on done events", () => {
    const { emit, subscription } = createSubscribedSessionHarness({ runId: "run" });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "done",
        timings: {
          prompt_n: 30_834,
          predicted_n: 34,
        },
      },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        usage: makeZeroUsageSnapshot(),
      },
    });

    expect(subscription.getUsageTotals()).toEqual({
      input: 30_834,
      output: 34,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: 30_868,
    });
  });

  it("does not double-count usage when done and message_end carry the same snapshot", () => {
    const { emit, subscription } = createSubscribedSessionHarness({ runId: "run" });
    const usage = {
      input: 100,
      output: 20,
      totalTokens: 120,
    };

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "done",
        message: {
          role: "assistant",
          usage,
        },
      },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        usage,
      },
    });

    expect(subscription.getUsageTotals()).toEqual({
      input: 100,
      output: 20,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: 120,
    });
  });

  it.each(THINKING_TAG_CASES)(
    "streams <%s> reasoning via onReasoningStream without leaking into final text",
    async ({ open, close }) => {
      const onReasoningStream = vi.fn();
      const onBlockReply = vi.fn();

      const { emit } = createSubscribedHarness({
        runId: "run",
        onReasoningStream,
        onBlockReply,
        blockReplyBreak: "message_end",
        reasoningMode: "stream",
      });

      emitAssistantTextDelta(emit, `${open}\nBecause`);
      emitAssistantTextDelta(emit, ` it helps\n${close}\n\nFinal answer`);

      const assistantMessage = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `${open}\nBecause it helps\n${close}\n\nFinal answer`,
          },
        ],
      } as AssistantMessage;

      emit({ type: "message_end", message: assistantMessage });
      await flushBlockReplyCallbacks();

      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(onBlockReply.mock.calls.at(0)?.[0].text).toBe("Final answer");

      const streamTexts = onReasoningStream.mock.calls
        .map((call) => call[0]?.text)
        .filter((value): value is string => typeof value === "string");
      expect(streamTexts.at(-1)).toBe("Because it helps");

      expect(assistantMessage.content).toEqual([
        { type: "thinking", thinking: "Because it helps" },
        { type: "text", text: "Final answer" },
      ]);
    },
  );

  it("suppresses assistant streaming while deterministic exec approval delivery is pending", async () => {
    let resolveToolResult: (() => void) | undefined;
    const onToolResult = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveToolResult = resolve;
        }),
    );
    const onPartialReply = vi.fn();

    const { emit } = createSubscribedHarness({
      runId: "run",
      onToolResult,
      onPartialReply,
    });

    emit({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-1",
      args: { command: "echo hi" },
    });
    emit({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "tool-1",
      isError: false,
      result: {
        details: {
          status: "approval-pending",
          approvalId: "12345678-1234-1234-1234-123456789012",
          approvalSlug: "12345678",
          host: "gateway",
          command: "echo hi",
        },
      },
    });

    emit({
      type: "message_start",
      message: { role: "assistant" },
    });
    emitAssistantTextDelta(emit, "After tool");

    await vi.waitFor(() => {
      expect(onToolResult).toHaveBeenCalledTimes(1);
    });
    expect(onPartialReply).not.toHaveBeenCalled();

    expect(resolveToolResult).toBeTypeOf("function");
    resolveToolResult?.();
    await Promise.resolve();
    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("blocks local MEDIA urls from case-variant tool names in verbose output", async () => {
    const onToolResult = vi.fn();
    const { emit } = createSubscribedHarness({
      runId: "run",
      onToolResult,
      verboseLevel: "full",
      builtinToolNames: new Set(["web_search"]),
    });

    emitToolRun({
      emit,
      toolName: "Web_Search",
      toolCallId: "tool-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "Fetched page\nMEDIA:/tmp/secret.png" }],
      },
    });

    await vi.waitFor(() => {
      expect(onToolResult).toHaveBeenCalledTimes(2);
    });
    const payload = onToolResult.mock.calls.at(-1)?.[0] as
      | { text?: string; mediaUrls?: string[] }
      | undefined;
    expect(payload?.text ?? "").toContain("Fetched page");
    expect(payload?.mediaUrls).toBeUndefined();
  });

  it("delivers generated image media once in markdown verbose output", async () => {
    const onToolResult = vi.fn();
    const onBlockReply = vi.fn();
    const { emit } = createSubscribedHarness({
      runId: "run",
      onToolResult,
      onBlockReply,
      verboseLevel: "full",
      blockReplyBreak: "message_end",
      builtinToolNames: new Set(["image_generate"]),
    });

    emitToolRun({
      emit,
      toolName: "image_generate",
      toolCallId: "tool-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "Generated 1 image with google/gemini-3.1-flash-image-preview.\nMEDIA:/tmp/generated.png",
          },
        ],
        details: {
          media: {
            mediaUrls: ["/tmp/generated.png"],
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(onToolResult).toHaveBeenCalledTimes(2);
    });
    const toolPayload = onToolResult.mock.calls.at(-1)?.[0] as
      | { text?: string; mediaUrls?: string[] }
      | undefined;
    expect(toolPayload?.text ?? "").toContain("Generated 1 image");
    expect(toolPayload?.mediaUrls).toBeUndefined();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "Here is the image.");
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is the image." }],
      },
    });
    await flushBlockReplyCallbacks();

    expectBlockReplyPayload(onBlockReply, {
      text: "Here is the image.",
      mediaUrls: ["/tmp/generated.png"],
    });
  });

  it("does not duplicate generated image media when the assistant reply has MEDIA lines", async () => {
    const onToolResult = vi.fn();
    const onBlockReply = vi.fn();
    const { emit } = createSubscribedHarness({
      runId: "run",
      onToolResult,
      onBlockReply,
      verboseLevel: "full",
      blockReplyBreak: "message_end",
      builtinToolNames: new Set(["image_generate"]),
    });

    emitToolRun({
      emit,
      toolName: "image_generate",
      toolCallId: "tool-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "Generated 1 image with google/gemini-3.1-flash-image-preview.\nMEDIA:/tmp/generated.png",
          },
        ],
        details: {
          media: {
            mediaUrls: ["/tmp/generated.png"],
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(onToolResult).toHaveBeenCalledTimes(2);
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "Here is the selected image.\nMEDIA:./selected.png");
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is the selected image.\nMEDIA:./selected.png" }],
      },
    });
    await flushBlockReplyCallbacks();

    expectBlockReplyPayload(onBlockReply, {
      text: "Here is the selected image.",
      mediaUrls: ["./selected.png"],
    });
  });

  it("does not attach generated image media to an early streamed chunk before explicit MEDIA", async () => {
    const onToolResult = vi.fn();
    const onBlockReply = vi.fn();
    const { emit } = createSubscribedHarness({
      runId: "run",
      onToolResult,
      onBlockReply,
      verboseLevel: "full",
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 5, maxChars: 200, breakPreference: "newline" },
      builtinToolNames: new Set(["image_generate"]),
    });

    emitToolRun({
      emit,
      toolName: "image_generate",
      toolCallId: "tool-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "Generated 1 image with google/gemini-3.1-flash-image-preview.\nMEDIA:/tmp/generated.png",
          },
        ],
        details: {
          media: {
            mediaUrls: ["/tmp/generated.png"],
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(onToolResult).toHaveBeenCalledTimes(2);
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "Generated 1 image.\n");

    expectBlockReplyPayload(onBlockReply, {
      text: "Generated 1 image.",
    });
    const earlyMediaPayloads = onBlockReply.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.mediaUrls?.length);
    expect(earlyMediaPayloads).toStrictEqual([]);

    emitAssistantTextDelta(emit, "MEDIA:/tmp/generated.png");
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Generated 1 image.\nMEDIA:/tmp/generated.png",
      },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Generated 1 image.\nMEDIA:/tmp/generated.png",
          },
        ],
      },
    });
    emit({ type: "agent_end" });
    await flushBlockReplyCallbacks();

    const mediaPayloads = onBlockReply.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.mediaUrls?.includes("/tmp/generated.png"));
    expect(mediaPayloads).toHaveLength(1);
  });

  it("attaches media from internal completion events even when assistant omits MEDIA lines", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createSubscribedHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
      internalEvents: [
        {
          type: "task_completion",
          source: "music_generation",
          childSessionKey: "music_generate:task-123",
          announceType: "music generation task",
          taskLabel: "lobster boss theme",
          status: "ok",
          statusLabel: "completed successfully",
          result: "Generated 1 track.\nMEDIA:/tmp/lobster-boss.mp3",
          mediaUrls: ["/tmp/lobster-boss.mp3"],
          replyInstruction: "Reply normally.",
        },
      ],
    });

    emit({
      type: "message_start",
      message: { role: "assistant" },
    });
    emitAssistantTextDelta(emit, "Here it is.");
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here it is." }],
      },
    });
    emit({ type: "agent_end" });
    await flushBlockReplyCallbacks();

    expectBlockReplyPayload(onBlockReply, {
      text: "Here it is.",
      mediaUrls: ["/tmp/lobster-boss.mp3"],
    });
  });

  it.each([
    {
      label: "music",
      source: "music_generation" as const,
      childSessionKey: "music_generate:task-123",
      announceType: "music generation task",
      taskLabel: "launch anthem",
      result: "Generated 1 track.\nMEDIA:/tmp/launch-anthem.mp3",
      mediaUrl: "/tmp/launch-anthem.mp3",
      firstChunk: "Generated 1 track.\n",
      finalText: "Generated 1 track.\nMEDIA:/tmp/launch-anthem.mp3",
    },
    {
      label: "video",
      source: "video_generation" as const,
      childSessionKey: "video_generate:task-123",
      announceType: "video generation task",
      taskLabel: "launch reel",
      result: "Generated 1 video.\nMEDIA:/tmp/launch-reel.mp4",
      mediaUrl: "/tmp/launch-reel.mp4",
      firstChunk: "Generated 1 video.\n",
      finalText: "Generated 1 video.\nMEDIA:/tmp/launch-reel.mp4",
    },
  ])(
    "does not attach $label internal completion media to an early streamed chunk before explicit MEDIA",
    async ({
      source,
      childSessionKey,
      announceType,
      taskLabel,
      result,
      mediaUrl,
      firstChunk,
      finalText,
    }) => {
      const onBlockReply = vi.fn();
      const { emit } = createSubscribedHarness({
        runId: "run",
        onBlockReply,
        blockReplyBreak: "text_end",
        blockReplyChunking: { minChars: 5, maxChars: 200, breakPreference: "newline" },
        internalEvents: [
          {
            type: "task_completion",
            source,
            childSessionKey,
            announceType,
            taskLabel,
            status: "ok",
            statusLabel: "completed successfully",
            result,
            mediaUrls: [mediaUrl],
            replyInstruction: "Reply normally.",
          },
        ],
      });

      emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextDelta(emit, firstChunk);

      expectBlockReplyPayload(onBlockReply, {
        text: firstChunk.trim(),
      });
      const earlyMediaPayloads = onBlockReply.mock.calls
        .map(([payload]) => payload)
        .filter((payload) => payload.mediaUrls?.length);
      expect(earlyMediaPayloads).toStrictEqual([]);

      emitAssistantTextDelta(emit, `MEDIA:${mediaUrl}`);
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_end",
          content: finalText,
        },
      });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: finalText,
            },
          ],
        },
      });
      emit({ type: "agent_end" });
      await flushBlockReplyCallbacks();

      const mediaPayloads = onBlockReply.mock.calls
        .map(([payload]) => payload)
        .filter((payload) => payload.mediaUrls?.includes(mediaUrl));
      expect(mediaPayloads).toHaveLength(1);
    },
  );

  it("keeps orphaned tool media available for non-block final payload assembly", () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      builtinToolNames: new Set(["tts"]),
    });

    emit({
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: {
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            audioAsVoice: true,
          },
        },
      },
    });
    emit({ type: "agent_end" });

    expect(subscription.getPendingToolMediaReply()).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
  });

  it.each(THINKING_TAG_CASES)(
    "suppresses <%s> blocks across chunk boundaries",
    async ({ open, close }) => {
      const onBlockReply = vi.fn();

      const { emit } = createSubscribedHarness({
        runId: "run",
        onBlockReply,
        blockReplyBreak: "text_end",
        blockReplyChunking: {
          minChars: 5,
          maxChars: 50,
          breakPreference: "newline",
        },
      });

      emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextDelta(emit, `${open}Reasoning chunk that should not leak`);

      expect(onBlockReply).not.toHaveBeenCalled();

      emitAssistantTextDelta(emit, `${close}\n\nFinal answer`);
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_end" },
      });
      await flushBlockReplyCallbacks();

      const payloadTexts = onBlockReply.mock.calls
        .map((call) => call[0]?.text)
        .filter((value): value is string => typeof value === "string");
      expect(payloadTexts).toEqual(["Final answer"]);
      for (const text of payloadTexts) {
        expect(text).not.toContain("Reasoning");
        expect(text).not.toContain(open);
      }
    },
  );

  it("streams native thinking_delta events and signals reasoning end", () => {
    const onReasoningStream = vi.fn();
    const onReasoningEnd = vi.fn();

    const { emit } = createSubscribedHarness({
      runId: "run",
      reasoningMode: "stream",
      onReasoningStream,
      onReasoningEnd,
    });

    emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Checking files" }],
      },
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "Checking files",
      },
    });

    emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Checking files done" }],
      },
      assistantMessageEvent: {
        type: "thinking_end",
      },
    });

    const streamTexts = onReasoningStream.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    expect(streamTexts.at(-1)).toBe("Checking files done");
    expect(onReasoningEnd).toHaveBeenCalledTimes(1);
  });

  it("extracts correct reasoning delta for incremental stream updates", () => {
    const emitAgentEventSpy = vi.spyOn(agentEvents, "emitAgentEvent").mockImplementation(() => {});
    const { emit } = createSubscribedHarness({
      runId: "run",
      reasoningMode: "stream",
      onReasoningStream: vi.fn(),
    });

    emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Step 1" }],
      },
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "Step 1",
      },
    });

    emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Step 1 and Step 2" }],
      },
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: " and Step 2",
      },
    });

    const thinkingEvents = emitAgentEventSpy.mock.calls
      .map((call) => call[0])
      .filter((evt) => evt?.stream === "thinking");

    expect(thinkingEvents.length).toBe(2);
    expect(thinkingEvents[0]?.data?.delta).toBe("Step 1");
    expect(thinkingEvents[1]?.data?.delta).toBe(" and Step 2");
    emitAgentEventSpy.mockRestore();
  });

  it("emits reasoning end once when native and tagged reasoning end overlap", () => {
    const onReasoningEnd = vi.fn();

    const { emit } = createSubscribedHarness({
      runId: "run",
      reasoningMode: "stream",
      onReasoningStream: vi.fn(),
      onReasoningEnd,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "<think>Checking");
    emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Checking" }],
      },
      assistantMessageEvent: {
        type: "thinking_end",
      },
    });

    emitAssistantTextDelta(emit, " files</think>\nFinal answer");

    expect(onReasoningEnd).toHaveBeenCalledTimes(1);
  });

  it("emits delta chunks in agent events for streaming assistant text", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: " world" },
    });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads[0]?.text).toBe("Hello");
    expect(payloads[0]?.delta).toBe("Hello");
    expect(payloads[1]?.text).toBe("Hello world");
    expect(payloads[1]?.delta).toBe(" world");
  });

  it("drops malformed streamed reasoning before orphan close tags when final text follows", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "private chain of thought </think> Visible answer");

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Visible answer");
    expect(payloads[0]?.delta).toBe("Visible answer");
  });

  it("emits agent events on message_end for non-streaming assistant text", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onAgentEvent,
    });
    emitMessageStartAndEndForAssistantText({ emit, text: "Hello world" });
    expectSingleAgentEventText(onAgentEvent.mock.calls, "Hello world");
  });

  it("does not emit duplicate agent events when message_end repeats", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;

    emit({ type: "message_start", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
  });

  it("emits one cleaned media snapshot when a streamed MEDIA line resolves to caption text", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "MEDIA:");
    emitAssistantTextDelta(emit, " https://example.com/a.png\nCaption");

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Caption");
    expect(payloads[0]?.delta).toBe("Caption");
    expect(payloads[0]?.replace).toBeUndefined();
    expect(payloads[0]?.mediaUrls).toEqual(["https://example.com/a.png"]);
  });

  it("emits agent events when media-only text is finalized", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "MEDIA: https://example.com/a.png");
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "MEDIA: https://example.com/a.png",
      },
    });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("");
    expect(payloads[0]?.mediaUrls).toEqual(["https://example.com/a.png"]);
  });

  it("keeps unresolved mutating failure when an unrelated tool succeeds", () => {
    const { emit, subscription } = createWriteFailureHarness({
      runId: "run-tools-1",
      path: "/tmp/demo.txt",
      content: "next",
    });

    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "r1",
      args: { path: "/tmp/demo.txt" },
      isError: false,
      result: { text: "ok" },
    });

    expect(subscription.getLastToolError()?.toolName).toBe("write");
  });

  it("clears unresolved mutating failure when the same action succeeds", () => {
    const { emit, subscription } = createWriteFailureHarness({
      runId: "run-tools-2",
      path: "/tmp/demo.txt",
      content: "next",
    });

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "w2",
      args: { path: "/tmp/demo.txt", content: "retry" },
      isError: false,
      result: { ok: true },
    });

    expect(subscription.getLastToolError()).toBeUndefined();
  });

  it("keeps unresolved mutating failure when same tool succeeds on a different target", () => {
    const { emit, subscription } = createToolErrorHarness("run-tools-3");

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "w1",
      args: { path: "/tmp/a.txt", content: "first" },
      isError: true,
      result: { error: "disk full" },
    });

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "w2",
      args: { path: "/tmp/b.txt", content: "second" },
      isError: false,
      result: { ok: true },
    });

    expect(subscription.getLastToolError()?.toolName).toBe("write");
  });

  it("keeps unresolved session_status model-mutation failure on later read-only status success", () => {
    const { emit, subscription } = createToolErrorHarness("run-tools-4");

    emitToolRun({
      emit,
      toolName: "session_status",
      toolCallId: "s1",
      args: { sessionKey: "agent:main:main", model: "openai/gpt-4o" },
      isError: true,
      result: { error: "Model not allowed." },
    });

    emitToolRun({
      emit,
      toolName: "session_status",
      toolCallId: "s2",
      args: { sessionKey: "agent:main:main" },
      isError: false,
      result: { ok: true },
    });

    expect(subscription.getLastToolError()?.toolName).toBe("session_status");
  });

  it("emits lifecycle:error event on agent_end when last assistant message was an error", () => {
    const { emit, onAgentEvent } = createAgentEventHarness({
      runId: "run-error",
      sessionKey: "test-session",
    });

    emitAssistantLifecycleErrorAndEnd({
      emit,
      errorMessage: "429 Rate limit exceeded",
    });

    // Look for lifecycle:error event
    const lifecycleError = findLifecycleErrorAgentEvent(onAgentEvent.mock.calls);

    if (!lifecycleError) {
      throw new Error("Expected lifecycle error event");
    }
    const error = (lifecycleError.data as { error?: unknown } | undefined)?.error;
    expect(typeof error).toBe("string");
    expect(error).toContain("API rate limit reached");
  });

  it("preserves replay-invalid lifecycle truth across compaction retries after mutating tools", () => {
    const { session, emit } = createStubSessionHarness();
    const onAgentEvent = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-replay-invalid-compaction",
      onAgentEvent,
      sessionKey: "test-session",
    });

    emitToolRun({
      emit,
      toolName: "edit",
      toolCallId: "edit-1",
      args: {
        file_path: "/tmp/demo.txt",
        old_string: "before",
        new_string: "after",
      },
      isError: false,
      result: { ok: true },
    });
    emit({ type: "compaction_end", willRetry: true, result: { summary: "compacted" } });
    emit({ type: "agent_end" });

    expect(subscription.getReplayState()).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expectLifecyclePayload(payloads, {
      phase: "end",
      livenessState: "abandoned",
      replayInvalid: true,
    });
  });

  it("preserves deterministic side-effect liveness across compaction retries", () => {
    const { session, emit } = createStubSessionHarness();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run-cron-side-effect-compaction",
      onAgentEvent,
      sessionKey: "test-session",
    });

    emitToolRun({
      emit,
      toolName: "cron",
      toolCallId: "cron-1",
      args: { action: "add", job: { name: "reminder" } },
      isError: false,
      result: { details: { status: "ok" } },
    });
    emit({ type: "compaction_end", willRetry: true, result: { summary: "compacted" } });
    emit({ type: "agent_end" });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expectLifecyclePayload(payloads, {
      phase: "end",
      livenessState: "working",
      replayInvalid: true,
    });
  });
});
