// Telegram tests cover inbound buffering identity.
import { describe, expect, it } from "vitest";
import {
  buildTelegramInboundDebounceConversationKey,
  buildTelegramInboundDebounceKey,
} from "./bot-handlers.debounce-key.js";

describe("buildTelegramInboundDebounceKey", () => {
  it("uses the resolved account id instead of literal default when provided", () => {
    expect(
      buildTelegramInboundDebounceKey({
        accountId: "work",
        conversationKey: "12345",
        senderId: "67890",
        debounceLane: "default",
      }),
    ).toBe("telegram:work:12345:67890:default");
  });

  it("falls back to literal default only when account id is actually absent", () => {
    expect(
      buildTelegramInboundDebounceKey({
        accountId: undefined,
        conversationKey: "12345",
        senderId: "67890",
        debounceLane: "forward",
      }),
    ).toBe("telegram:default:12345:67890:forward");
  });

  it("keeps scoped topic thread ids in the conversation key", () => {
    const topic100 = buildTelegramInboundDebounceConversationKey({
      chatId: 7,
      threadSpec: { id: 100, scope: "forum" },
    });
    const topic200 = buildTelegramInboundDebounceConversationKey({
      chatId: 7,
      threadSpec: { id: 200, scope: "forum" },
    });

    expect(topic100).toBe("7:topic:100");
    expect(topic200).toBe("7:topic:200");
    expect(
      buildTelegramInboundDebounceConversationKey({
        chatId: 7,
        threadSpec: { id: 100, scope: "direct-messages" },
      }),
    ).toBe("7:direct-topic:100");
    expect(
      buildTelegramInboundDebounceKey({
        accountId: "default",
        conversationKey: topic100,
        senderId: "42",
        debounceLane: "default",
      }),
    ).not.toBe(
      buildTelegramInboundDebounceKey({
        accountId: "default",
        conversationKey: topic200,
        senderId: "42",
        debounceLane: "default",
      }),
    );
  });

  it("uses the chat id as the conversation key when no thread is present", () => {
    expect(
      buildTelegramInboundDebounceConversationKey({ chatId: 7, threadSpec: { scope: "none" } }),
    ).toBe("7");
  });
});
