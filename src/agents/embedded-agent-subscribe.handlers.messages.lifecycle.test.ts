import { describe, expect, it, vi } from "vitest";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { handleMessageEnd } from "./embedded-agent-subscribe.handlers.messages.lifecycle.js";
import {
  createMessageEndContext,
  createMessageToolEnvelope,
  endMessage,
  firstMockCall,
  firstMockArg,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { createOpenAiResponsesTextBlock } from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

describe("handleMessageEnd", () => {
  it("emits audio-only directives as message-end block replies", () => {
    const emitBlockReply = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      consumeReplyDirectives: vi.fn(() => null),
      state: {
        blockBuffer: "",
        deltaBuffer: "",
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[[audio_as_voice]]" }],
      },
    } as never);

    expect(emitBlockReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(emitBlockReply, "block reply")).toMatchObject({
      text: "",
      audioAsVoice: true,
    });
  });

  it.each(["answer part A msg [[E1008]timeout] answer part B", "answer ending ["])(
    "keeps malformed directive-looking final text identical across delivery paths: %s",
    (text) => {
      const onAgentEvent = vi.fn();
      const emitBlockReply = vi.fn();
      const flushBlockReplyBuffer = vi.fn();
      const accumulator = createStreamingDirectiveAccumulator();
      const streamed = accumulator.consume(text)?.text ?? "";
      const ctx = createMessageEndContext({
        onAgentEvent,
        emitBlockReply,
        flushBlockReplyBuffer,
        consumeReplyDirectives: vi.fn((chunk: string, options?: { final?: boolean }) =>
          accumulator.consume(chunk, options),
        ),
        blockChunker: {
          hasBuffered: () => true,
          reset: vi.fn(),
        },
        state: {
          blockBuffer: streamed,
          deltaBuffer: streamed,
        },
      });

      void endMessage(ctx, {
        message: { role: "assistant", content: [{ type: "text", text }] },
      });

      expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
        stream: "assistant",
        data: { text, delta: text },
      });
      const finalBlockText = (firstMockArg(emitBlockReply, "block reply") as { text?: string })
        .text;
      expect(`${streamed}${finalBlockText ?? ""}`).toBe(text);
      expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(expect.objectContaining({ text }));
    },
  );

  it("keeps exact NO_REPLY silent after a user-facing message send followed by sessions_send (#119383)", () => {
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      finalizeAssistantTexts,
      consumeReplyDirectives: vi.fn((text: string) => ({ text })),
      state: {
        blockBuffer: "",
        deltaBuffer: "",
        messagingToolSentTexts: ["<user-facing reply>", "<internal escalation note>"],
        messagingToolSentTextsNormalized: ["<user-facing reply>", "<internal escalation note>"],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "whatsapp",
            to: "user:123",
            text: "<user-facing reply>",
          },
        ],
      },
    });

    void endMessage(ctx, {
      message: { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    });

    // The exact silent token must never be rewritten to the sessions_send body:
    // the final assistant text keeps NO_REPLY and no block reply carries the note.
    expect(finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "NO_REPLY" }),
    );
    for (const call of emitBlockReply.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("<internal escalation note>");
    }
  });

  it("keeps exact NO_REPLY silent when only sessions_send delivered (#119383)", () => {
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      finalizeAssistantTexts,
      consumeReplyDirectives: vi.fn((text: string) => ({ text })),
      state: {
        blockBuffer: "",
        deltaBuffer: "",
        messagingToolSentTexts: ["<internal escalation note>"],
        messagingToolSentTextsNormalized: ["<internal escalation note>"],
        messagingToolSentTargets: [],
      },
    });

    void endMessage(ctx, {
      message: { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    });

    expect(finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "NO_REPLY" }),
    );
    for (const call of emitBlockReply.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("<internal escalation note>");
    }
  });

  it("preserves real-parser NO_REPLY as terminal evidence without channel delivery", () => {
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const accumulator = createStreamingDirectiveAccumulator();
    const ctx = createMessageEndContext({
      emitBlockReply,
      finalizeAssistantTexts,
      consumeReplyDirectives: vi.fn((text: string, options?: { final?: boolean }) =>
        accumulator.consume(text, options),
      ),
      state: {
        blockBuffer: "",
        deltaBuffer: "",
      },
    });

    void endMessage(ctx, {
      message: { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    });

    expect(finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "NO_REPLY" }),
    );
    expect(emitBlockReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "counts a completed provider assistant message",
      message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      expected: 1,
    },
    {
      name: "ignores transcript-only mirrored assistant messages",
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: "Done." }],
      },
      expected: 0,
    },
    {
      name: "ignores non-assistant messages",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
      expected: 0,
    },
  ])("$name for assistantTurnCount", ({ message, expected }) => {
    const ctx = createMessageEndContext({ state: { assistantTurnCount: 0 } });

    void endMessage(ctx, { message });

    expect(ctx.state.assistantTurnCount).toBe(expected);
  });

  it("keeps duplicate-reply diagnostics free of lone surrogates", () => {
    const text = `${"a".repeat(49)}😀tail`;
    const ctx = createMessageEndContext({
      consumeReplyDirectives: vi.fn((value: string) => ({ text: value })),
      state: { messagingToolSentTextsNormalized: [`${"a".repeat(49)}tail`] },
    });

    void endMessage(ctx, {
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    const diagnostic = (ctx.log.debug as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .find((value) => String(value).startsWith("Skipping message_end block reply"));
    expect(diagnostic).toEqual(expect.any(String));
    expect(Buffer.from(String(diagnostic)).toString()).toBe(diagnostic);
  });

  it("persists streamed usage when the final assistant snapshot is zeroed", () => {
    const ctx = createMessageEndContext({
      state: {
        pendingAssistantUsage: { input: 7, output: 5, reasoningTokens: 2, total: 12 },
      },
    });
    const message = {
      role: "assistant",
      api: "openai-completions",
      content: [{ type: "text", text: "Done." }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
    };

    void endMessage(ctx, {
      message,
    });

    expect(firstMockArg(ctx.noteLastAssistant as never, "last assistant")).toMatchObject({
      usage: {
        input: 7,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 2,
        totalTokens: 12,
      },
    });
    expect(ctx.recordAssistantUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 7,
        output: 5,
        reasoningTokens: 2,
        totalTokens: 12,
      }),
    );
  });

  it("keeps authoritative final usage instead of pending stream usage", () => {
    const ctx = createMessageEndContext({
      state: {
        pendingAssistantUsage: { input: 7, output: 5, total: 12 },
      },
    });
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      usage: {
        input: 11,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14,
      },
    };

    void endMessage(ctx, {
      message,
    });

    expect(firstMockArg(ctx.noteLastAssistant as never, "last assistant")).toBe(message);
    expect(ctx.recordAssistantUsage).toHaveBeenCalledWith(message.usage);
  });

  it("suppresses repeated validation-loop assistant message-end text", () => {
    const onAgentEvent = vi.fn();
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      emitBlockReply,
      finalizeAssistantTexts,
      state: {
        lastToolError: {
          toolName: "edit",
          validationErrorSummary: "edit tool validation failed: invalid arguments",
        },
      },
    });
    const text =
      'Stopped after 2 identical failed edit tool calls. Validation failed for tool "edit": Received arguments: {}';

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text }],
        stopReason: "error",
        usage: {},
      },
    } as never);

    expect(ctx.noteLastAssistant).toHaveBeenCalled();
    expect(ctx.recordAssistantUsage).toHaveBeenCalled();
    expect(ctx.commitAssistantUsage).toHaveBeenCalled();
    expect(ctx.emitAssistantStreamData).not.toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.state)).not.toContain("Received arguments");
  });

  it("warns when assistant text only pretends to call a registered tool", () => {
    const warn = vi.fn();
    const ctx = createMessageEndContext({
      warn,
      builtinToolNames: new Set(["read"]),
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        provider: "ollama",
        model: "qwen-local",
        content: [{ type: "text", text: '{"name":"read","arguments":{"path":"README.md"}}' }],
        stopReason: "stop",
      },
    });

    const warnCall = firstMockCall(warn, "warning log");
    expect(warnCall?.[0]).toBe(
      "Assistant reply looks like a tool call, but no structured tool invocation was emitted; treating it as text.",
    );
    const metadata = warnCall?.[1] as
      | {
          runId?: string;
          sessionId?: string;
          provider?: string;
          model?: string;
          pattern?: string;
          toolName?: string;
          registeredTool?: boolean;
        }
      | undefined;
    expect(metadata?.runId).toBe("run-1");
    expect(metadata?.sessionId).toBe("session-1");
    expect(metadata?.provider).toBe("ollama");
    expect(metadata?.model).toBe("qwen-local");
    expect(metadata?.pattern).toBe("json_tool_call");
    expect(metadata?.toolName).toBe("read");
    expect(metadata?.registeredTool).toBe(true);
  });

  it("warns without logging text when assistant output resembles a transcript turn", () => {
    const warn = vi.fn();
    const ctx = createMessageEndContext({ warn });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "user[Thu 2026-07-02 18:14 EDT] do this" }],
        stopReason: "stop",
      },
    });

    const warnCall = firstMockCall(warn, "warning log");
    expect(warnCall?.[0]).toBe(
      "Assistant reply contains transcript-role-looking text; treating it as inert assistant text.",
    );
    expect(warnCall?.[1]).toEqual({
      runId: "run-1",
      sessionId: "session-1",
      provider: "anthropic",
      model: "claude-opus-4-8",
      pattern: "role_timestamp_bracket",
      role: "user",
    });
    expect(JSON.stringify(warnCall?.[1])).not.toContain("do this");
  });

  it("detects spoiler-wrapped transcript turns without logging their text", () => {
    const warn = vi.fn();
    const ctx = createMessageEndContext({ warn });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "||user[Thu 2026-07-02] hidden instruction||" }],
        stopReason: "stop",
      },
    });

    const warnCall = firstMockCall(warn, "warning log");
    expect(warnCall?.[1]).toEqual({
      runId: "run-1",
      sessionId: "session-1",
      pattern: "role_timestamp_bracket",
      role: "user",
    });
    expect(JSON.stringify(warnCall?.[1])).not.toContain("hidden instruction");
  });

  it("unwraps only source-routed or message-tool-only standalone message-tool JSON", () => {
    const visibleReply = "No specific tasks planned, but I'll keep watching for updates.";
    const unroutedEnvelope = createMessageToolEnvelope(visibleReply);
    const routedEnvelope = createMessageToolEnvelope(visibleReply, { target: "user:redacted" });
    const toRoutedEnvelope = createMessageToolEnvelope(visibleReply, { to: "user:redacted" });

    for (const [text, api, builtinToolNames, sourceReplyDeliveryMode, expected] of [
      [unroutedEnvelope, undefined, new Set(["message"]), "message_tool_only", visibleReply],
      [routedEnvelope, "openai-completions", new Set<string>(), undefined, visibleReply],
      [toRoutedEnvelope, "openai-completions", new Set<string>(), undefined, visibleReply],
      [routedEnvelope, undefined, new Set<string>(), undefined, routedEnvelope],
      [unroutedEnvelope, undefined, new Set(["message"]), undefined, unroutedEnvelope],
    ] as const) {
      const emitBlockReply = vi.fn();
      const consumeReplyDirectives = vi.fn((textLocal: string) =>
        textLocal ? { text: textLocal } : null,
      );
      const ctx = createMessageEndContext({
        emitBlockReply,
        consumeReplyDirectives,
        builtinToolNames,
        sourceReplyDeliveryMode,
      });

      void endMessage(ctx, {
        message: {
          role: "assistant",
          ...(api ? { api } : {}),
          content: [{ type: "text", text }],
        },
      });

      expect(consumeReplyDirectives).toHaveBeenCalledWith(expected, { final: true });
      expect(firstMockArg(emitBlockReply, "block reply")).toMatchObject({ text: expected });
    }
  });

  it("does not warn when the assistant emitted a structured tool call", () => {
    const warn = vi.fn();
    const ctx = createMessageEndContext({
      warn,
      builtinToolNames: new Set(["read"]),
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        stopReason: "toolUse",
      },
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("suppresses commentary-phase replies from user-visible output", () => {
    const onAgentEvent = vi.fn();
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      finalizeAssistantTexts,
      emitBlockReply,
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        phase: "commentary",
        content: [{ type: "text", text: "Need send." }],
        usage: { input: 1, output: 1, total: 2 },
      },
    });

    // Archive-always: commentary reaches the bus/archive but not the visible reply.
    expect(onAgentEvent).toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it("strips continuation signals from commentary message_end snapshots", () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({ onAgentEvent });
    const message = {
      role: "assistant",
      api: "openai-completions",
      phase: "commentary",
      content: [{ type: "text", text: "Working before tool.\nCONTINUE_WORK" }],
      usage: { input: 1, output: 1, total: 2 },
    };

    void handleMessageEnd(ctx, {
      type: "message_end",
      message,
    } as never);

    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: {
        text: "Working before tool.",
        replace: true,
        phase: "commentary",
      },
    });
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("CONTINUE_WORK");
    expect(ctx.noteCompletedAssistant).toHaveBeenCalledWith(expect.objectContaining(message));
  });

  it("keeps signal-only Responses commentary off the assistant event bus", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: { deltaBuffer: "CONTINUE_WORK" },
    });
    const message = {
      role: "assistant",
      api: "openai-responses",
      phase: "commentary",
      content: [{ type: "text", text: "CONTINUE_WORK" }],
      usage: { input: 1, output: 1, total: 2 },
    };

    await handleMessageEnd(ctx, {
      type: "message_end",
      message,
    } as never);

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(ctx.noteCompletedAssistant).toHaveBeenCalledWith(expect.objectContaining(message));
  });

  it("does not re-expose sensitive incomplete commentary markers at message_end", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: {
        deltaBuffer: "Working before tool.\nCONTINUE_WOR",
        lastStreamedCommentary: "Working before tool.\n",
      },
    });
    const message = {
      role: "assistant",
      api: "openai-responses",
      phase: "commentary",
      content: [{ type: "text", text: "Working before tool.\nCONTINUE_WOR" }],
      usage: { input: 1, output: 1, total: 2 },
    };

    await handleMessageEnd(ctx, {
      type: "message_end",
      message,
    } as never);

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(ctx.noteCompletedAssistant).toHaveBeenCalledWith(expect.objectContaining(message));
  });

  it("releases short false-positive commentary prefixes as deltas at message_end", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: {
        deltaBuffer: "Ordinary C",
        lastStreamedCommentary: "Ordinary ",
        commentaryStreamedWithDelta: true,
      },
    });
    const message = {
      role: "assistant",
      api: "openai-responses",
      phase: "commentary",
      content: [{ type: "text", text: "Ordinary C" }],
      usage: { input: 1, output: 1, total: 2 },
    };

    await handleMessageEnd(ctx, {
      type: "message_end",
      message,
    } as never);

    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: {
        delta: "C",
        phase: "commentary",
      },
    });
  });

  it("retains Anthropic commentary item IDs when message_end releases a suffix", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: {
        deltaBuffer: "Ordinary C",
        lastStreamedCommentary: "Ordinary ",
        commentaryStreamedWithDelta: true,
        lastAssistantStreamItemId: "anthropic-item",
      },
    });
    const message = {
      role: "assistant",
      api: "anthropic-messages",
      phase: "commentary",
      content: [{ type: "text", text: "Ordinary C" }],
      usage: { input: 1, output: 1, total: 2 },
    };

    await handleMessageEnd(ctx, {
      type: "message_end",
      message,
    } as never);

    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: {
        delta: "C",
        phase: "commentary",
        itemId: "anthropic-item",
      },
    });
  });

  it("suppresses commentary message_end when phase exists only in textSignature metadata", () => {
    const onAgentEvent = vi.fn();
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      finalizeAssistantTexts,
      emitBlockReply,
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "Need send.",
            id: "msg_sig",
            phase: "commentary",
          }),
        ],
        usage: { input: 1, output: 1, total: 2 },
      },
    });

    // Archive-always: commentary (textSignature-only phase) reaches the
    // bus/archive but not the visible reply.
    expect(onAgentEvent).toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it("does not duplicate block reply for text_end channels when text was already delivered", () => {
    const onBlockReply = vi.fn();
    const emitBlockReply = vi.fn();
    // In real usage, the directive accumulator returns null for empty/consumed
    // input. The non-empty call shouldn't happen for text_end channels (that's
    // the safety send we're guarding against).
    const consumeReplyDirectives = vi.fn((text: string) => (text ? { text } : null));
    const ctx = createMessageEndContext({
      onBlockReply,
      emitBlockReply,
      consumeReplyDirectives,
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Hello world",
        blockReplyBreak: "text_end",
        // Simulate text_end already delivered this text through emitBlockChunk
        lastBlockReplyText: "Hello world",
        deliveredBlockReplyTexts: ["Hello world"],
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    // The block reply should NOT fire again since text_end already delivered it.
    // consumeReplyDirectives is called once with "" (the final flush for
    // text_end channels) but returns null, so emitBlockReply is never called.
    expect(emitBlockReply).not.toHaveBeenCalled();
  });

  it("tags message-end safety replies with the current assistant message", () => {
    const emitBlockReply = vi.fn();
    const ctx = createMessageEndContext({
      onBlockReply: vi.fn(),
      emitBlockReply,
      consumeReplyDirectives: vi.fn((text: string) => (text ? { text } : null)),
      state: {
        assistantMessageIndex: 7,
        blockReplyBreak: "text_end",
        lastBlockReplyText: null,
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(emitBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Final answer" }),
      expect.objectContaining({ assistantMessageIndex: 7 }),
    );
  });

  it("corrects text_end block replies when canonical message_end text differs", () => {
    const onBlockReply = vi.fn();
    const emitBlockReply = vi.fn();
    // Same pattern: directive accumulator returns null for empty final flush
    const consumeReplyDirectives = vi.fn((text: string) => (text ? { text } : null));
    const ctx = createMessageEndContext({
      onBlockReply,
      emitBlockReply,
      consumeReplyDirectives,
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Hello world",
        blockReplyBreak: "text_end",
        // text_end delivered via emitBlockChunk which uses different stripping
        lastBlockReplyText: "Hello world.",
        deliveredBlockReplyTexts: ["Hello world."],
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        // The raw text differs slightly from lastBlockReplyText due to stripping
        content: [{ type: "text", text: "Hello world" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(emitBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello world" }),
      expect.objectContaining({ assistantMessageIndex: undefined }),
    );
  });

  it("emits final media and malformed pending text after an async buffered flush", async () => {
    const emitBlockReply = vi.fn();
    let resolveFlush: (() => void) | undefined;
    const flushBlockReplyBuffer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = () => {
            emitBlockReply({ mediaUrls: ["/tmp/final.png"] });
            ctx.state.lastDeliveredAssistantReplyDirectives = {
              mediaUrls: ["/tmp/final.png"],
            };
            resolve();
          };
        }),
    );
    const accumulator = createStreamingDirectiveAccumulator();
    const text = "[[reply_to_current]]\nCaption [[oops\nMEDIA:/tmp/final.png";
    const streamed = accumulator.consume("[[reply_to_current]]\nCaption")?.text ?? "";
    accumulator.consume(" [[oops\nMEDIA:/tmp/final.png");
    const consumeReplyDirectives = vi.fn((chunk: string, options?: { final?: boolean }) =>
      accumulator.consume(chunk, options),
    );
    const ctx = createMessageEndContext({
      emitBlockReply,
      flushBlockReplyBuffer,
      consumeReplyDirectives,
      blockChunker: {
        hasBuffered: () => true,
        reset: vi.fn(),
      },
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Caption [[oops",
        blockReplyBreak: "message_end",
        deltaBuffer: streamed,
        blockBuffer: streamed,
      },
    });

    const pending = endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(flushBlockReplyBuffer).toHaveBeenCalledWith({
      assistantMessageIndex: undefined,
      final: true,
    });
    expect(emitBlockReply).not.toHaveBeenCalled();
    resolveFlush?.();
    await pending;
    expect(consumeReplyDirectives).toHaveBeenCalledWith("", { final: true });
    const replies = emitBlockReply.mock.calls.map(
      ([reply]) =>
        reply as {
          text?: string;
          mediaUrls?: string[];
          replyToCurrent?: boolean;
        },
    );
    const finalReply = replies.at(-1);
    if (!finalReply) {
      throw new Error("Expected final block reply");
    }
    expect(finalReply).toMatchObject({
      text: "Caption [[oops",
      mediaUrls: undefined,
      replyToCurrent: true,
    });
    expect(replies.flatMap((reply) => reply.mediaUrls ?? [])).toEqual(["/tmp/final.png"]);
    expect(replies.map((reply) => reply.text ?? "").join("")).not.toContain("MEDIA:");
  });

  it("does not re-emit final media already delivered at text_end", () => {
    const emitBlockReply = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      consumeReplyDirectives: vi.fn(() => null),
      state: {
        blockReplyBreak: "text_end",
        blockBuffer: "",
        deltaBuffer: "",
        lastBlockReplyText: "Caption",
        lastDeliveredAssistantReplyDirectives: {
          mediaUrls: ["/tmp/final.png"],
        },
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Caption\nMEDIA:/tmp/final.png" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    } as never);

    expect(emitBlockReply).not.toHaveBeenCalled();
  });

  it("preserves literal reasoning-looking tags in unphased final visible text", () => {
    const onAgentEvent = vi.fn();
    const stripBlockTags = vi.fn(() => "Before");
    const ctx = createMessageEndContext({
      onAgentEvent,
      stripBlockTags,
      consumeReplyDirectives: vi.fn((text: string) => ({ text })),
      state: {
        blockBuffer: "",
        deltaBuffer: "",
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Before <think>literal tag text after",
            textSignature: JSON.stringify({ v: 1, id: "item_unphased" }),
          },
        ],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(stripBlockTags).not.toHaveBeenCalled();
    expect(firstMockArg(ctx.emitAssistantStreamData as never, "assistant stream")).toMatchObject({
      text: "Before <think>literal tag text after",
      delta: "Before <think>literal tag text after",
    });
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Before <think>literal tag text after" }),
    );
  });

  it("keeps final-tag enforcement in message_end fallback", () => {
    const onAgentEvent = vi.fn();
    const stripBlockTags = vi.fn(() => "");
    const ctx = createMessageEndContext({
      enforceFinalTag: true,
      onAgentEvent,
      stripBlockTags,
      consumeReplyDirectives: vi.fn((text: string) => ({ text })),
      state: {
        assistantTexts: ["Hello world"],
        assistantTextBaseline: 0,
        blockReplyBreak: "text_end",
        blockBuffer: "",
        deltaBuffer: "",
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: "Hello world",
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(stripBlockTags).toHaveBeenCalledWith(
      "Hello world",
      { thinking: false, final: false },
      { final: true },
    );
    expect(ctx.emitAssistantStreamData).not.toHaveBeenCalled();
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "", reconcileCurrentMessage: true }),
    );
  });

  it("preserves reply-target-only streamed text as terminal evidence without delivering it", () => {
    const emitBlockReply = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      consumeReplyDirectives: vi.fn(() => null),
      state: {
        assistantTexts: ["[[reply_to_current]]"],
        assistantTextBaseline: 0,
        blockReplyBreak: "text_end",
        blockBuffer: "",
        deltaBuffer: "",
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[[reply_to_current]]" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(ctx.emitAssistantStreamData).not.toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "[[reply_to_current]]",
        addedDuringMessage: true,
        reconcileCurrentMessage: false,
      }),
    );
  });

  it("emits a replacement final assistant event when final_answer appears only at message_end", () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Working...",
        blockReplyBreak: "text_end",
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "Working...",
            id: "item_commentary",
            phase: "commentary",
          }),
          createOpenAiResponsesTextBlock({
            text: "Done.",
            id: "item_final",
            phase: "final_answer",
          }),
        ],
        stopReason: "stop",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.2",
        usage: {},
        timestamp: 0,
      },
    });

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    const event = firstMockArg(onAgentEvent, "agent event") as
      | { stream?: string; data?: { text?: string; delta?: string; replace?: boolean } }
      | undefined;
    expect(event?.stream).toBe("assistant");
    expect(event?.data?.text).toBe("Done.");
    expect(event?.data?.delta).toBe("");
    expect(event?.data?.replace).toBe(true);
  });
});
