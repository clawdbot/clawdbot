// Text-end delivery, snapshot reconciliation, and replay de-duplication.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  extractTextPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";

function createUnphasedAssistant(texts: string[]) {
  return {
    role: "assistant",
    api: "google-generative-ai",
    provider: "google",
    model: "gemini-2.5-flash",
    content: texts.map((text) => ({ type: "text", text })),
  };
}

describe("text_end snapshot reconciliation", () => {
  it.each(["text_end", "message_end"] as const)(
    "preserves an orphan-close replacement after a drained raw prefix at %s",
    async (terminal) => {
      const onAgentEvent = vi.fn();
      const onBlockReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-orphan-close-drained-prefix",
        onAgentEvent,
        onBlockReply,
        blockReplyBreak: "text_end",
        blockReplyChunking: { minChars: 10, maxChars: 16, breakPreference: "sentence" },
      });
      const answer = "This is the complete visible answer.";
      let rawText = "";
      try {
        emit({ type: "message_start", message: createUnphasedAssistant([]) });
        for (const [index, delta] of ["private chain. ", `</mm:think>${answer}`].entries()) {
          rawText += delta;
          const partial = createUnphasedAssistant([rawText]);
          emit({
            type: "message_update",
            message: partial,
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
          });
          await subscription.waitForPendingEvents();
          if (index === 0) {
            expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(["private chain."]);
          }
        }
        const message = createUnphasedAssistant([rawText]);
        emit(
          terminal === "message_end"
            ? { type: "message_end", message }
            : {
                type: "message_update",
                message,
                assistantMessageEvent: {
                  type: "text_end",
                  contentIndex: 0,
                  content: rawText,
                  partial: message,
                },
              },
        );
        await subscription.waitForPendingEvents();

        const delivered = extractTextPayloads(onBlockReply.mock.calls);
        expect(delivered[0]).toBe("private chain.");
        expect(delivered.slice(1).join(" ")).toBe(answer);
        emit({ type: "message_end", message });
        await subscription.waitForPendingEvents();
        expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(delivered);
        expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
          stream: "assistant",
          data: { text: answer },
        });
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    {
      name: "clears a withdrawn reply",
      priorBlocks: [],
      finalBlock: "",
      expectedText: "",
      expectedBlocks: [],
    },
    {
      name: "retains text when the checkpoint is absent",
      priorBlocks: [],
      finalBlock: undefined,
      expectedText: "Draft",
      expectedBlocks: ["Draft"],
    },
    {
      name: "preserves an earlier block when the last block is withdrawn",
      priorBlocks: ["First."],
      finalBlock: "",
      expectedText: "First.",
      expectedBlocks: ["First."],
    },
    {
      name: "corrects a later block without replaying an earlier delivered block",
      priorBlocks: ["First"],
      finalBlock: "Corrected",
      expectedText: "First\nCorrected",
      expectedBlocks: ["First", "Corrected"],
    },
  ])(
    "unphased terminal checkpoint $name",
    async ({ priorBlocks, finalBlock, expectedText, expectedBlocks }) => {
      const onAgentEvent = vi.fn();
      const onBlockReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-unphased-checkpoint",
        onAgentEvent,
        onBlockReply,
        blockReplyBreak: "text_end",
      });
      emit({ type: "message_start", message: createUnphasedAssistant([]) });
      const streamedBlocks = [...priorBlocks, "Draft"];
      for (const [contentIndex, text] of streamedBlocks.entries()) {
        const partial = createUnphasedAssistant(streamedBlocks.slice(0, contentIndex + 1));
        emit({
          type: "message_update",
          message: partial,
          assistantMessageEvent: { type: "text_delta", contentIndex, delta: text, partial },
        });
        if (contentIndex < priorBlocks.length) {
          emit({
            type: "message_update",
            message: partial,
            assistantMessageEvent: { type: "text_end", contentIndex, content: text, partial },
          });
          await subscription.waitForPendingEvents();
          expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(
            priorBlocks.slice(0, contentIndex + 1),
          );
        }
      }
      expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
        stream: "assistant",
        data: { text: streamedBlocks.join("") },
      });
      onAgentEvent.mockClear();

      if (finalBlock === undefined) {
        emitAssistantTextEnd({ emit });
      } else {
        const partial = createUnphasedAssistant([...priorBlocks, finalBlock]);
        emit({
          type: "message_update",
          message: partial,
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: priorBlocks.length,
            content: finalBlock,
            partial,
          },
        });
      }
      await subscription.waitForPendingEvents();

      expect({
        events: onAgentEvent.mock.calls.map(([event]) => event),
        blocks: extractTextPayloads(onBlockReply.mock.calls),
        assistantTexts: subscription.assistantTexts,
      }).toMatchObject({
        events:
          finalBlock === undefined
            ? []
            : [{ stream: "assistant", data: { text: expectedText, delta: "", replace: true } }],
        blocks: expectedBlocks,
        assistantTexts: expectedBlocks,
      });
      expect(onBlockReply).toHaveBeenCalledTimes(expectedBlocks.length);
    },
  );

  it.each([
    {
      name: "unchanged",
      checkpoint: "Hello world. Next sentence. Tail",
      expectedTail: ["Tail"],
    },
    {
      name: "shortened",
      checkpoint: "Hello world. Next sentence.",
      expectedTail: [],
    },
    {
      name: "corrected-tail",
      checkpoint: "Hello world. Next sentence. Fixed tail",
      expectedTail: ["Fixed tail"],
    },
  ])(
    "preserves delivered sentence chunks at a $name unphased checkpoint",
    async ({ checkpoint, expectedTail }) => {
      const onBlockReply = vi.fn();
      const { emit, subscription } = createTextEndBlockReplyHarness({
        onBlockReply,
        blockReplyChunking: { minChars: 10, maxChars: 16, breakPreference: "sentence" },
      });
      const first = "First block.";
      const delivered = [first, "Hello world.", "Next sentence."];
      try {
        emit({ type: "message_start", message: createUnphasedAssistant([]) });
        const firstPartial = createUnphasedAssistant([first]);
        for (const type of ["text_delta", "text_end"] as const) {
          emit({
            type: "message_update",
            message: firstPartial,
            assistantMessageEvent: {
              type,
              contentIndex: 0,
              ...(type === "text_delta" ? { delta: first } : { content: first }),
              partial: firstPartial,
            },
          });
        }
        await subscription.waitForPendingEvents();
        expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([first]);

        let second = "";
        for (const delta of ["Hello world. ", "Next sentence. ", "Tail"]) {
          second += delta;
          const partial = createUnphasedAssistant([first, second]);
          emit({
            type: "message_update",
            message: partial,
            assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta, partial },
          });
        }
        await subscription.waitForPendingEvents();
        expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(delivered);
        expect(subscription.assistantTexts).toEqual(delivered);

        // The cumulative checkpoint adds a native-block separator, not new block text.
        const partial = createUnphasedAssistant([first, checkpoint]);
        emit({
          type: "message_update",
          message: partial,
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 1,
            content: checkpoint,
            partial,
          },
        });
        await subscription.waitForPendingEvents();

        expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([
          ...delivered,
          ...expectedTail,
        ]);
        expect(subscription.assistantTexts).toEqual([...delivered, ...expectedTail]);
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    {
      name: "text already contained in the delivered block",
      first: "First Second",
      later: "Second",
      enforceFinalTag: false,
      expectedBlocks: ["First Second", "Second"],
    },
    {
      name: "identical text in distinct blocks",
      first: "Same",
      later: "Same",
      enforceFinalTag: false,
      expectedBlocks: ["Same", "Same"],
    },
    {
      name: "final tags spanning content blocks",
      first: "<final>First",
      later: "Second</final>",
      enforceFinalTag: true,
      expectedBlocks: ["First", "Second"],
    },
  ])(
    "delivers an unphased block first seen at message_end with $name",
    async ({ first, later, enforceFinalTag, expectedBlocks }) => {
      const onAgentEvent = vi.fn();
      const onBlockReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-unphased-message-end-block",
        onAgentEvent,
        onBlockReply,
        blockReplyBreak: "text_end",
        enforceFinalTag,
      });
      emit({ type: "message_start", message: createUnphasedAssistant([]) });
      const partial = createUnphasedAssistant([first]);
      emit({
        type: "message_update",
        message: partial,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: first, partial },
      });
      emit({
        type: "message_update",
        message: partial,
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: first, partial },
      });
      await subscription.waitForPendingEvents();
      expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(expectedBlocks.slice(0, 1));
      expect(subscription.assistantTexts).toEqual(expectedBlocks.slice(0, 1));

      emit({ type: "message_end", message: createUnphasedAssistant([first, later]) });
      await subscription.waitForPendingEvents();

      expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(expectedBlocks);
      expect(subscription.assistantTexts).toEqual(expectedBlocks);
      expect(onBlockReply).toHaveBeenCalledTimes(expectedBlocks.length);
      expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
        stream: "assistant",
        data: { text: expectedBlocks.join("\n") },
      });
    },
  );

  it("does not read future blocks from shared mutable text_end partials", async () => {
    const onAgentEvent = vi.fn();
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-shared-future-partial",
      onAgentEvent,
      onBlockReply,
      blockReplyBreak: "text_end",
    });
    // Google queues the same mutable output object; later blocks can already
    // exist when the subscriber handles an earlier block's end event.
    const partial = {
      ...createUnphasedAssistant([]),
      content: [
        { type: "text", text: "First" },
        { type: "thinking", thinking: "Private reasoning" },
        { type: "text", text: "Second" },
      ],
    };
    try {
      emit({ type: "message_start", message: partial });
      for (const [contentIndex, text, expected] of [
        [0, "First", ["First"]],
        [2, "Second", ["First", "Second"]],
      ] as const) {
        for (const type of ["text_delta", "text_end"] as const) {
          emit({
            type: "message_update",
            message: partial,
            assistantMessageEvent: {
              type,
              contentIndex,
              ...(type === "text_delta" ? { delta: text } : { content: text }),
              partial,
            },
          });
        }
        await subscription.waitForPendingEvents();
        expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(expected);
        expect(subscription.assistantTexts).toEqual(expected);
        expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
          stream: "assistant",
          data: { text: expected.join("\n") },
        });
      }
      emit({ type: "message_end", message: partial });
      await subscription.waitForPendingEvents();

      expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(["First", "Second"]);
      expect(subscription.assistantTexts).toEqual(["First", "Second"]);
      expect(onBlockReply).toHaveBeenCalledTimes(2);
    } finally {
      subscription.unsubscribe();
    }
  });

  it.each([
    {
      name: "reasoning visibility",
      chunks: ["<think>sensitive reasoning", "</think>Hello"],
      enforceFinalTag: false,
      expectedTexts: ["Hello"],
    },
    {
      name: "final-tag-only visibility",
      chunks: ["sensitive reasoning", "<final>Hello</final>"],
      enforceFinalTag: true,
      expectedTexts: ["Hello"],
    },
    {
      name: "final-tag suppression",
      chunks: ["sensitive reasoning"],
      enforceFinalTag: true,
      expectedTexts: [],
    },
    {
      name: "a reasoning tag split across native content blocks",
      chunks: ["<thi", "nk>sensitive reasoning</think>Hello"],
      separateBlocks: true,
      enforceFinalTag: false,
      expectedTexts: ["Hello"],
    },
    {
      name: "a final tag split across native content blocks",
      chunks: ["<fi", "nal>Hello</final>"],
      separateBlocks: true,
      enforceFinalTag: true,
      expectedTexts: ["Hello"],
    },
    {
      name: "literal tags inside a fence split across native content blocks",
      chunks: ["``", "`\n<think>literal</think>\n```\n"],
      separateBlocks: true,
      enforceFinalTag: false,
      expectedTexts: ["```\n<think>literal</think>\n```"],
    },
    {
      name: "a native block separator before a code fence",
      chunks: ["Intro", "~~~\n<think>literal</think>\n~~~"],
      separateBlocks: true,
      onlyCheckpoint: true,
      enforceFinalTag: false,
      expectedTexts: ["Intro\n~~~\n<think>literal</think>\n~~~"],
    },
    {
      name: "a reasoning tag completed only at message_end",
      chunks: ["<thi", "nk>sensitive reasoning"],
      separateBlocks: true,
      terminalContinuation: true,
      enforceFinalTag: false,
      expectedTexts: [],
    },
    {
      name: "a final tag completed only at message_end",
      chunks: ["<fi", "nal>Hello</final>"],
      separateBlocks: true,
      terminalContinuation: true,
      enforceFinalTag: true,
      expectedTexts: ["Hello"],
    },
    {
      name: "a fence completed only at message_end",
      chunks: ["``", "`\n<think>literal</think>\n```\n"],
      separateBlocks: true,
      terminalContinuation: true,
      enforceFinalTag: false,
      expectedTexts: ["```\n<think>literal</think>\n```"],
    },
  ])(
    "unphased terminal checkpoint preserves $name",
    async ({
      chunks,
      separateBlocks,
      onlyCheckpoint,
      terminalContinuation,
      enforceFinalTag,
      expectedTexts,
    }) => {
      const onAgentEvent = vi.fn();
      const onBlockReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-unphased-checkpoint-visibility",
        onAgentEvent,
        onBlockReply,
        blockReplyBreak: "text_end",
        enforceFinalTag,
      });
      const visibleUpdates = () =>
        onAgentEvent.mock.calls
          .filter(([event]) => event.stream === "assistant")
          .map(([event]) => event.data.text);
      emit({ type: "message_start", message: createUnphasedAssistant([]) });
      let text = "";
      const streamedChunks = onlyCheckpoint
        ? []
        : terminalContinuation
          ? chunks.slice(0, 1)
          : chunks;
      for (const [index, delta] of streamedChunks.entries()) {
        text += delta;
        const partial = createUnphasedAssistant(
          separateBlocks ? chunks.slice(0, index + 1) : [text],
        );
        emit({
          type: "message_update",
          message: partial,
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: separateBlocks ? index : 0,
            delta,
            partial,
          },
        });
        expect(visibleUpdates()).toEqual(index === chunks.length - 1 ? expectedTexts : []);
      }

      const partial = createUnphasedAssistant(separateBlocks ? chunks : [text]);
      emit(
        terminalContinuation
          ? { type: "message_end", message: partial }
          : {
              type: "message_update",
              message: partial,
              assistantMessageEvent: {
                type: "text_end",
                contentIndex: separateBlocks ? chunks.length - 1 : 0,
                content: separateBlocks ? chunks.at(-1) : text,
                partial,
              },
            },
      );
      await subscription.waitForPendingEvents();

      expect({
        events: visibleUpdates(),
        blocks: extractTextPayloads(onBlockReply.mock.calls),
        assistantTexts: subscription.assistantTexts,
      }).toEqual({
        events: expectedTexts,
        blocks: expectedTexts,
        assistantTexts: expectedTexts,
      });
      if (!terminalContinuation) {
        emit({ type: "message_end", message: partial });
      }
      await subscription.waitForPendingEvents();
      expect(visibleUpdates()).toEqual(expectedTexts);
      expect(subscription.assistantTexts).toEqual(expectedTexts);
      expect(onBlockReply).toHaveBeenCalledTimes(expectedTexts.length);
    },
  );

  function setupTextEndSubscription() {
    // text_end block replies expose snapshot/delta merge behavior without the
    // extra message-end terminal path.
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    const emitDelta = (delta: string) => {
      emitAssistantTextDelta({ emit, delta });
    };

    const emitTextEnd = (content: string) => {
      emitAssistantTextEnd({ emit, content });
    };

    return { onBlockReply, subscription, emitDelta, emitTextEnd };
  }

  it.each([
    {
      name: "does not append when text_end content is a prefix of deltas",
      delta: "Hello world",
      content: "Hello",
      expected: "Hello world",
    },
    {
      name: "does not append when text_end content is already contained",
      delta: "Hello world",
      content: "world",
      expected: "Hello world",
    },
    {
      name: "appends suffix when text_end content extends deltas",
      delta: "Hello",
      content: "Hello world",
      expected: "Hello world",
    },
  ])("$name", async ({ delta, content, expected }) => {
    const { onBlockReply, subscription, emitDelta, emitTextEnd } = setupTextEndSubscription();

    emitDelta(delta);
    emitTextEnd(content);
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    expect(subscription.assistantTexts).toEqual([expected]);
  });

  it("sends only the suffix when text_end block replies grow across assistant messages", async () => {
    // After a tool call, providers can resend the full accumulated text; only
    // the newly grown suffix should be emitted as a block reply.
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    const emitAssistantSnapshot = (content: string) => {
      emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextEnd({ emit, content });
    };
    const emitToolStart = (toolCallId: string) => {
      emit({
        type: "tool_execution_start",
        toolName: "browser",
        toolCallId,
        args: {},
      });
    };

    emitAssistantSnapshot("Let me grab actual eBay prices:");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });

    emitToolStart("tool-1");
    await Promise.resolve();
    emitAssistantSnapshot("Let me grab actual eBay prices:Let me grab actual prices from eBay:");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(2);
    });

    emitToolStart("tool-2");
    await Promise.resolve();
    emitAssistantSnapshot(
      "Let me grab actual eBay prices:Let me grab actual prices from eBay:eBay blocks live pricing:",
    );
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(3);
    });

    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([
      "Let me grab actual eBay prices:",
      "Let me grab actual prices from eBay:",
      "eBay blocks live pricing:",
    ]);
    expect(subscription.assistantTexts).toEqual([
      "Let me grab actual eBay prices:",
      "Let me grab actual prices from eBay:",
      "eBay blocks live pricing:",
    ]);
  });

  it.each([
    {
      name: "keeps a full later reply that shares a prefix without an intervening tool call",
      replies: ["OK", "OK, here's the detail"],
    },
    {
      name: "keeps a full post-tool reply when the prior block is not a preamble",
      replies: ["Checking...", "Checking... found X"],
      toolCallId: "tool-post-check",
    },
    {
      name: "keeps a full post-tool reply when the shared prefix is whitespace-separated",
      replies: ["Checking:", "Checking: found X"],
      toolCallId: "tool-post-check-colon",
    },
  ] satisfies Array<{ name: string; replies: [string, string]; toolCallId?: string }>)(
    "$name",
    async ({ replies, toolCallId }) => {
      const onBlockReply = vi.fn();
      const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });
      const emitAssistantSnapshot = (content: string) => {
        emit({ type: "message_start", message: { role: "assistant" } });
        emitAssistantTextEnd({ emit, content });
      };

      emitAssistantSnapshot(replies[0]);
      await vi.waitFor(() => {
        expect(onBlockReply).toHaveBeenCalledTimes(1);
      });
      if (toolCallId) {
        emit({ type: "tool_execution_start", toolName: "browser", toolCallId, args: {} });
        await Promise.resolve();
      }
      emitAssistantSnapshot(replies[1]);
      await vi.waitFor(() => {
        expect(onBlockReply).toHaveBeenCalledTimes(2);
      });

      expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(replies);
      expect(subscription.assistantTexts).toEqual(replies);
    },
  );

  it("does not safety-send a cumulative text_end reply when the suffix was sent by a messaging tool", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextEnd({ emit, content: "Checking:" });
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });

    emit({
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "message-tool-1",
      args: { action: "send", to: "+1555", message: "Fetched prices" },
    });
    await Promise.resolve();
    emit({
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "message-tool-1",
      isError: false,
      result: {
        details: {
          status: "sent",
        },
      },
    });
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextEnd({ emit, content: "Checking: Fetched prices" });
    await Promise.resolve();
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Checking: Fetched prices" }],
      },
    });
    await Promise.resolve();

    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(["Checking:"]);
  });
});

describe("text_end replay de-duplication", () => {
  it.each(["text_end", "checkpoint text_end", "message_end"] as const)(
    "preserves split reply directives after a delivered chunk through %s",
    async (terminal) => {
      const onBlockReply = vi.fn();
      const { emit, subscription } = createTextEndBlockReplyHarness({
        onBlockReply,
        blockReplyChunking: { minChars: 13, maxChars: 13, breakPreference: "newline" },
      });
      try {
        emit({ type: "message_start", message: createUnphasedAssistant([]) });
        // The 13-character chunk delivers Hi while its directive opener stays in the parser.
        for (const delta of ["Hi[[reply_to:", "target]]Bye"]) {
          emitAssistantTextDelta({ emit, delta });
          expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(["Hi"]);
        }
        const text = "Hi[[reply_to:target]]Bye";
        const message = createUnphasedAssistant([text]);
        if (terminal === "message_end") {
          emit({ type: "message_end", message });
        } else {
          emit({
            type: "message_update",
            message,
            assistantMessageEvent: {
              type: "text_end",
              content: text,
              ...(terminal === "checkpoint text_end" ? { partial: message } : {}),
            },
          });
        }
        await subscription.waitForPendingEvents();

        expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(["Hi", "Bye"]);
        expect(onBlockReply.mock.calls.at(-1)?.[0]).toMatchObject({
          text: "Bye",
          replyToId: "target",
          replyToTag: true,
        });
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it("does not duplicate when text_end repeats full content", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ emit, delta: "Good morning!" });
    emitAssistantTextEnd({ emit, content: "Good morning!" });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    expect(subscription.assistantTexts).toEqual(["Good morning!"]);
  });
  it("does not duplicate block chunks when text_end repeats full content", async () => {
    // Chunked deltas may already flush all visible text before text_end repeats
    // the same content; the snapshot must be ignored.
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({
      onBlockReply,
      blockReplyChunking: {
        minChars: 5,
        maxChars: 40,
        breakPreference: "newline",
      },
    });

    const fullText = "First line\nSecond line\nThird line\n";

    emitAssistantTextDelta({ emit, delta: fullText });
    await Promise.resolve();

    const callsAfterDelta = onBlockReply.mock.calls.length;
    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([
      "First line\nSecond line\nThird line",
    ]);

    emitAssistantTextEnd({ emit, content: fullText });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(callsAfterDelta);
  });
});

describe("assistant snapshot replay", () => {
  it("does not emit duplicate block replies when text_end repeats", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ emit, delta: "Hello block" });
    emitAssistantTextEnd({ emit });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });
  it.each([
    {
      name: "does not duplicate assistantTexts when message_end repeats",
      text: "Hello world",
    },
    {
      name: "does not duplicate assistantTexts when message_end repeats with trailing whitespace changes",
      text: "Hello world\n",
      repeatText: "Hello world",
    },
    {
      name: "does not duplicate assistantTexts when message_end repeats with reasoning blocks",
      text: "Hello world",
      thinking: "Because",
    },
  ])("$name", ({ text, repeatText, thinking }) => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      reasoningMode: thinking ? "on" : undefined,
    });
    const assistantMessage = {
      role: "assistant",
      content: [...(thinking ? [{ type: "thinking", thinking }] : []), { type: "text", text }],
    } as AssistantMessage;
    const repeatedMessage =
      repeatText === undefined
        ? assistantMessage
        : ({
            role: "assistant",
            content: [{ type: "text", text: repeatText }],
          } as AssistantMessage);

    emit({ type: "message_end", message: assistantMessage });
    emit({ type: "message_end", message: repeatedMessage });

    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });
  it("keeps the completed assistant independent from transcript mutation", () => {
    const { emit, subscription } = createSubscribedSessionHarness({ runId: "run" });
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Current run reply" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });
    assistantMessage.content = [{ type: "text", text: "Rewritten transcript reply" }];

    expect(subscription.getCurrentAttemptAssistant()?.content).toEqual([
      { type: "text", text: "Current run reply" },
    ]);
  });
  it("populates assistantTexts for non-streaming models with chunking enabled", () => {
    // Non-streaming providers may only send message_end; assistantTexts still
    // needs the final visible reply even when block chunking is enabled.
    // Non-streaming models (e.g. zai/glm-4.7): no text_delta events; message_end
    // must still populate assistantTexts so providers can deliver a final reply.
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      blockReplyChunking: { minChars: 50, maxChars: 200 }, // Chunking enabled
    });

    // Simulate non-streaming model: only message_start and message_end, no text_delta
    emit({ type: "message_start", message: { role: "assistant" } });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Response from non-streaming model" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Response from non-streaming model"]);
  });
});
