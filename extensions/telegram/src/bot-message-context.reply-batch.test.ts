import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext reply/quote debounce batches", () => {
  it("preserves a quote carried by a non-first buffered message", async () => {
    const chat = { id: 999, type: "private" as const, first_name: "Alice" };
    const sender = { id: 42, first_name: "Alice", is_bot: false };
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 2,
        chat,
        from: sender,
        text: "plain note\nquoting note",
      },
      options: {
        inboundDebounceMessages: [
          {
            message_id: 1,
            date: 1_700_000_000,
            chat,
            from: sender,
            text: "plain note",
          },
          {
            message_id: 2,
            date: 1_700_000_001,
            chat,
            from: sender,
            text: "quoting note",
            reply_to_message: {
              message_id: 90,
              date: 1_699_999_000,
              chat,
              from: { id: 7, first_name: "Bob", is_bot: false },
              text: "the quoted source line",
            },
            quote: { text: "the quoted source line", position: 0 },
          },
        ],
      },
    });

    expect(context?.ctxPayload.Body).toContain("the quoted source line");
  });

  // Control: the identical quote on the FIRST buffered entry must be visible.
  // Without this, a failure above could just mean "quotes never reach Body".
  it("CONTROL: preserves the same quote when it is on the first buffered message", async () => {
    const chat = { id: 999, type: "private" as const, first_name: "Alice" };
    const sender = { id: 42, first_name: "Alice", is_bot: false };
    const quoting = {
      message_id: 1,
      date: 1_700_000_000,
      chat,
      from: sender,
      text: "quoting note",
      reply_to_message: {
        message_id: 90,
        date: 1_699_999_000,
        chat,
        from: { id: 7, first_name: "Bob", is_bot: false },
        text: "the quoted source line",
      },
      quote: { text: "the quoted source line", position: 0 },
    };
    const context = await buildTelegramMessageContextForTest({
      message: { ...quoting, message_id: 2, text: "quoting note\nplain note" },
      options: {
        inboundDebounceMessages: [
          quoting,
          { message_id: 2, date: 1_700_000_001, chat, from: sender, text: "plain note" },
        ],
      },
    });

    expect(context?.ctxPayload.Body).toContain("the quoted source line");
  });

  it("lists a source re-quoted by two buffered messages only once", async () => {
    const chat = { id: 999, type: "private" as const, first_name: "Alice" };
    const sender = { id: 42, first_name: "Alice", is_bot: false };
    const source = {
      message_id: 90,
      date: 1_699_999_000,
      chat,
      from: { id: 7, first_name: "Bob", is_bot: false },
      text: "the quoted source line",
    };
    const quoting = (messageId: number, text: string) => ({
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat,
      from: sender,
      text,
      reply_to_message: source,
      quote: { text: "the quoted source line", position: 0 },
    });
    const context = await buildTelegramMessageContextForTest({
      message: { message_id: 3, chat, from: sender, text: "first ask\nsecond ask" },
      options: { inboundDebounceMessages: [quoting(1, "first ask"), quoting(2, "second ask")] },
    });

    const body = context?.ctxPayload.Body ?? "";
    expect(body).toContain("the quoted source line");
    expect(body.split("the quoted source line").length - 1).toBe(1);
  });
});
