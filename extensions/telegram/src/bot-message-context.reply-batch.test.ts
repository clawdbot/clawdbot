import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const CHAT = { id: 999, type: "private" as const, first_name: "Alice" };
const SENDER = { id: 42, first_name: "Alice", is_bot: false as const };
const QUOTED_LINE = "the quoted source line";
// `ReplyMessage` is a Message pinned to `reply_to_message: undefined`, so the
// embedded reply target cannot itself nest another one.
const REPLY_TARGET = {
  message_id: 90,
  date: 1_699_999_000,
  chat: CHAT,
  text: QUOTED_LINE,
  from: { id: 7, first_name: "Bob", is_bot: false as const },
  reply_to_message: undefined,
};

function quotingMessage(messageId: number, text: string) {
  return {
    message_id: messageId,
    date: 1_700_000_000 + messageId,
    chat: CHAT,
    from: SENDER,
    text,
    reply_to_message: REPLY_TARGET,
    quote: { text: QUOTED_LINE, position: 0 },
  };
}

function plainMessage(messageId: number, text: string) {
  return { message_id: messageId, date: 1_700_000_000 + messageId, chat: CHAT, from: SENDER, text };
}

describe("buildTelegramMessageContext reply/quote debounce batches", () => {
  it("preserves a quote carried by a non-first buffered message", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: plainMessage(2, "plain note\nquoting note"),
      options: {
        inboundDebounceMessages: [plainMessage(1, "plain note"), quotingMessage(2, "quoting note")],
      },
    });

    expect(context?.ctxPayload.Body).toContain(QUOTED_LINE);
  });

  // Control: the identical quote on the FIRST buffered entry must be visible.
  // Without this, a failure above could just mean "quotes never reach Body".
  it("CONTROL: preserves the same quote when it is on the first buffered message", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: quotingMessage(2, "quoting note\nplain note"),
      options: {
        inboundDebounceMessages: [quotingMessage(1, "quoting note"), plainMessage(2, "plain note")],
      },
    });

    expect(context?.ctxPayload.Body).toContain(QUOTED_LINE);
  });

  it("lists a source re-quoted by two buffered messages only once", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: plainMessage(3, "first ask\nsecond ask"),
      options: {
        inboundDebounceMessages: [quotingMessage(1, "first ask"), quotingMessage(2, "second ask")],
      },
    });

    const body = context?.ctxPayload.Body ?? "";
    expect(body).toContain(QUOTED_LINE);
    expect(body.split(QUOTED_LINE).length - 1).toBe(1);
  });
});
