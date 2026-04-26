import { describe, expect, it } from "vitest";
import {
  buildTelegramSendParams,
  buildTelegramThreadReplyParams,
  removeTelegramNativeQuoteParam,
  resolveTelegramSendThreadSpec,
} from "./reply-parameters.js";

describe("telegram reply parameters", () => {
  it("preserves exact quote text and quote metadata for native Telegram replies", () => {
    expect(
      buildTelegramSendParams({
        replyToMessageId: 42,
        replyQuoteMessageId: 42,
        replyQuoteText: " quoted text\n",
        replyQuotePosition: 12.9,
        replyQuoteEntities: [{ type: "bold", offset: 1, length: 6 }],
        thread: { id: 99, scope: "forum" },
        silent: true,
      }),
    ).toEqual({
      message_thread_id: 99,
      reply_parameters: {
        message_id: 42,
        quote: " quoted text\n",
        quote_position: 12,
        quote_entities: [{ type: "bold", offset: 1, length: 6 }],
        allow_sending_without_reply: true,
      },
      disable_notification: true,
    });
  });

  it("uses the selected reply id as the quote id when direct sends only provide quote text", () => {
    expect(
      buildTelegramThreadReplyParams({
        replyToMessageId: 77,
        replyQuoteText: "  exact slice  ",
        useReplyIdAsQuoteSource: true,
      }),
    ).toEqual({
      reply_parameters: {
        message_id: 77,
        quote: "  exact slice  ",
        allow_sending_without_reply: true,
      },
    });
  });

  it("falls back to legacy reply id for blank quotes or mismatched quote sources", () => {
    expect(
      buildTelegramThreadReplyParams({
        replyToMessageId: 77,
        replyQuoteMessageId: 78,
        replyQuoteText: "quoted",
      }),
    ).toEqual({
      reply_to_message_id: 77,
      allow_sending_without_reply: true,
    });

    expect(
      buildTelegramThreadReplyParams({
        replyToMessageId: 77,
        replyQuoteText: " \n\t",
      }),
    ).toEqual({
      reply_to_message_id: 77,
      allow_sending_without_reply: true,
    });
  });

  it("converts rejected native quote params to legacy reply params for retry", () => {
    expect(
      removeTelegramNativeQuoteParam({
        parse_mode: "HTML",
        reply_parameters: {
          message_id: 42,
          quote: "quoted",
          allow_sending_without_reply: true,
        },
      }),
    ).toEqual({
      parse_mode: "HTML",
      reply_to_message_id: 42,
      allow_sending_without_reply: true,
    });
  });

  it("keeps direct-message topic scope for Telegram DM topics", () => {
    expect(
      buildTelegramThreadReplyParams({
        thread: resolveTelegramSendThreadSpec({
          targetMessageThreadId: 5,
          chatType: "direct",
        }),
        replyToMessageId: 42,
      }),
    ).toEqual({
      message_thread_id: 5,
      reply_to_message_id: 42,
      allow_sending_without_reply: true,
    });
  });
});
