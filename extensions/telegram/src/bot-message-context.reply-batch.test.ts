import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { TELEGRAM_REPLY_CHAIN_MAX_DEPTH } from "./message-cache.js";

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

/** A quoting message whose reply target is unique, so none of them dedupe away. */
function quotingDistinctSource(messageId: number) {
  const sourceText = `distinct source ${messageId}`;
  return {
    message_id: messageId,
    date: 1_700_000_000 + messageId,
    chat: CHAT,
    from: SENDER,
    text: `ask ${messageId}`,
    reply_to_message: { ...REPLY_TARGET, message_id: 500 + messageId, text: sourceText },
    quote: { text: sourceText, position: 0 },
  };
}

function countReplyChainEntries(body: string): number {
  const block = body.match(/\[Reply chain - nearest first\]\n([\s\S]*?)\n\[\/Reply chain\]/)?.[1];
  if (!block) {
    return 0;
  }
  // Entries render as `[1. Bob id:501]` followed by their body lines.
  return block.split("\n").filter((line) => /^\[\d+\. /.test(line)).length;
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

  // The cap must not spend all its slots on the first message's inherited
  // ancestry, or it suppresses exactly the later quote this path recovers.
  it("keeps a later quote when the first message already has a full reply ancestry", async () => {
    const ancestry = Array.from({ length: TELEGRAM_REPLY_CHAIN_MAX_DEPTH }, (_, i) => ({
      messageId: String(900 + i),
      sender: "Bob",
      body: `ancestor ${i}`,
    }));
    const context = await buildTelegramMessageContextForTest({
      message: plainMessage(2, "plain note\nquoting note"),
      replyChain: ancestry,
      options: {
        inboundDebounceMessages: [plainMessage(1, "plain note"), quotingMessage(2, "quoting note")],
      },
    });

    const body = context?.ctxPayload.Body ?? "";
    expect(body).toContain(QUOTED_LINE);
    expect(countReplyChainEntries(body)).toBeLessThanOrEqual(TELEGRAM_REPLY_CHAIN_MAX_DEPTH);
  });

  // A debounce window has no per-item cap of its own, so without a bound here a
  // burst of distinct quote-replies would grow model-visible context without limit.
  it("caps batch-derived reply targets at the canonical chain depth", async () => {
    const burst = Array.from({ length: TELEGRAM_REPLY_CHAIN_MAX_DEPTH * 2 + 2 }, (_, i) =>
      quotingDistinctSource(i + 1),
    );
    const context = await buildTelegramMessageContextForTest({
      message: plainMessage(99, burst.map((entry) => entry.text).join("\n")),
      options: { inboundDebounceMessages: burst },
    });

    const entries = countReplyChainEntries(context?.ctxPayload.Body ?? "");
    expect(entries).toBeGreaterThan(0);
    expect(entries).toBeLessThanOrEqual(TELEGRAM_REPLY_CHAIN_MAX_DEPTH);
  });
});
