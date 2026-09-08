import { describe, expect, it, vi } from "vitest";
import {
  createMessageEndContext,
  createMessageToolEnvelope,
  endMessage,
  firstMockCall,
  firstMockArg,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

describe("handleMessageEnd", () => {
  it.each(["answer part A msg [[E1008]timeout] answer part B", "answer ending ["])(
    "keeps malformed directive-looking final text identical across delivery paths: %s",
    (text) => {
      const onAgentEvent = vi.fn();
      const onBlockReply = vi.fn();
      const ctx = createMessageEndContext({ onAgentEvent, onBlockReply });
      ctx.blockChunker.append(text);
      void ctx.flushBlockReplyBuffer();
      const streamed = (firstMockArg(onBlockReply, "streamed block reply") as { text: string })
        .text;
      onBlockReply.mockClear();

      void endMessage(ctx, {
        message: { role: "assistant", content: [{ type: "text", text }] },
      });

      expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
        stream: "assistant",
        data: { text, delta: text },
      });
      const finalBlockText = (firstMockArg(onBlockReply, "block reply") as { text?: string }).text;
      expect(`${streamed}${finalBlockText ?? ""}`).toBe(text);
      expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(expect.objectContaining({ text }));
    },
  );

  it.each([true, false])(
    "keeps exact NO_REPLY silent after sessions_send (prior user-facing send: %s) (#119383)",
    (withUserFacingSend) => {
      const onBlockReply = vi.fn();
      const finalizeAssistantTexts = vi.fn();
      const sentTexts = withUserFacingSend
        ? ["<user-facing reply>", "<internal escalation note>"]
        : ["<internal escalation note>"];
      const ctx = createMessageEndContext({
        onBlockReply,
        finalizeAssistantTexts,
        state: {
          deltaBuffer: "",
          messagingToolSentTexts: sentTexts,
          messagingToolSentTextsNormalized: [...sentTexts],
          messagingToolSentTargets: withUserFacingSend
            ? [
                {
                  tool: "message",
                  provider: "whatsapp",
                  to: "user:123",
                  text: "<user-facing reply>",
                },
              ]
            : [],
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
      for (const call of onBlockReply.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("<internal escalation note>");
      }
    },
  );

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
      state: { messagingToolSentTextsNormalized: [`${"a".repeat(49)}tail`] },
    });

    void endMessage(ctx, {
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    const diagnostic = (ctx.log.debug as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .find((value) =>
        String(value).startsWith("Skipping block reply - already sent via messaging tool"),
      );
    expect(diagnostic).toEqual(expect.any(String));
    expect(Buffer.from(String(diagnostic)).toString()).toBe(diagnostic);
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
      const onBlockReply = vi.fn();
      const ctx = createMessageEndContext({
        onBlockReply,
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

      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(firstMockArg(onBlockReply, "block reply")).toMatchObject({ text: expected });
      expect(ctx.state.assistantTexts).toEqual([expected]);
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

  it.each([
    {
      name: "message phase",
      message: { phase: "commentary", content: [{ type: "text", text: "Need send." }] },
    },
    {
      name: "textSignature-only phase",
      message: {
        content: [
          createOpenAiResponsesTextBlock({
            text: "Need send.",
            id: "msg_sig",
            phase: "commentary",
          }),
        ],
      },
    },
  ])("suppresses user-visible commentary with $name", ({ message }) => {
    const onAgentEvent = vi.fn();
    const onBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      finalizeAssistantTexts,
      onBlockReply,
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        ...message,
        usage: { input: 1, output: 1, total: 2 },
      },
    });

    // Archive-always: commentary reaches the bus/archive but not the visible reply.
    expect(onAgentEvent).toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it.each(["Hello world", "Hello world."])(
    "does not duplicate text_end block replies after %j was delivered",
    (lastBlockReplyText) => {
      const onBlockReply = vi.fn();
      const ctx = createMessageEndContext({
        onBlockReply,
        state: {
          assistantStream: { raw: "", text: "Hello world" },
          blockReplyBreak: "text_end",
          deltaBuffer: "",
        },
      });
      ctx.blockChunker.append(lastBlockReplyText);
      void ctx.flushBlockReplyBuffer({ final: true });
      expect(onBlockReply.mock.calls.map(([reply]) => reply.text)).toEqual([lastBlockReplyText]);
      onBlockReply.mockClear();

      void endMessage(ctx, {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
          usage: { input: 10, output: 5, total: 15 },
        },
      });

      expect(onBlockReply).not.toHaveBeenCalled();
    },
  );

  it("tags message-end safety replies with the current assistant message", () => {
    const onBlockReply = vi.fn();
    const ctx = createMessageEndContext({
      onBlockReply,
      state: {
        assistantMessageIndex: 7,
        blockReplyBreak: "text_end",
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply).toHaveBeenCalledWith(expect.objectContaining({ text: "Final answer" }), {
      assistantMessageIndex: 7,
    });
  });

  it("emits final media and malformed pending text after flushing buffered message_end text", () => {
    const onBlockReply = vi.fn();
    const text = "Caption [[oops\nMEDIA:/tmp/final.png";
    const ctx = createMessageEndContext({
      onBlockReply,
      state: {
        assistantStream: { raw: "", text: "Caption [[oops" },
        blockReplyBreak: "message_end",
      },
    });
    ctx.blockChunker.append(text);
    void ctx.flushBlockReplyBuffer();
    const streamed = (firstMockArg(onBlockReply, "streamed block reply") as { text: string }).text;
    expect(onBlockReply.mock.calls.flatMap(([reply]) => reply.mediaUrls ?? [])).toEqual([]);
    onBlockReply.mockClear();

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(onBlockReply).toHaveBeenCalledOnce();
    const finalReply = firstMockArg(onBlockReply, "block reply") as {
      text?: string;
      mediaUrls?: string[];
    };
    expect(finalReply).toMatchObject({
      text: " [[oops",
      mediaUrls: ["/tmp/final.png"],
    });
    expect(`${streamed}${finalReply.text ?? ""}`).toBe("Caption [[oops");
  });

  it("preserves literal reasoning-looking tags in unphased final visible text", () => {
    const onAgentEvent = vi.fn();
    const stripBlockTags = vi.fn(() => "Before");
    const ctx = createMessageEndContext({
      onAgentEvent,
      stripBlockTags,
      state: {
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
    expect(firstMockArg(onAgentEvent, "assistant stream")).toMatchObject({
      stream: "assistant",
      data: {
        text: "Before <think>literal tag text after",
        delta: "Before <think>literal tag text after",
      },
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
      state: {
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
      expect.objectContaining({ thinking: false, final: false }),
      { final: true },
    );
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
  });

  it.each(["Working...", ""])(
    "reconciles an empty final snapshot after streamed text %j",
    (previousText) => {
      const onAgentEvent = vi.fn();
      const ctx = createMessageEndContext({
        onAgentEvent,
        bufferedText: previousText,
        state: {
          assistantStream: { raw: "", text: previousText },
          deltaBuffer: previousText,
        },
      });
      if (previousText) {
        ctx.emitAssistantStreamData({ text: previousText, delta: previousText });
        onAgentEvent.mockClear();
      }

      void endMessage(ctx, {
        message: createOpenAiResponsesPartial({
          text: "",
          id: "item-final",
          signaturePhase: "final_answer",
          partialPhase: "final_answer",
        }),
      });

      expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject(
        previousText ? [{ stream: "assistant", data: { text: "", delta: "", replace: true } }] : [],
      );
      expect(ctx.emitBlockReply).not.toHaveBeenCalled();
      expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(
        expect.objectContaining({ text: "" }),
      );
      expect(ctx.blockChunker.bufferedText).toBe("");
    },
  );

  it("emits a replacement final assistant event when final_answer appears only at message_end", () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: {
        assistantStream: { raw: "", text: "Working..." },
        blockReplyBreak: "text_end",
        deltaBuffer: "",
      },
    });
    ctx.emitAssistantStreamData({ text: "Working...", delta: "Working..." });
    onAgentEvent.mockClear();

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
