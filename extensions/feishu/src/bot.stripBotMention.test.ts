// Feishu tests cover bot.stripBotMention plugin behavior.
import { describe, expect, it } from "vitest";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";

function makeEvent(
  text: string,
  mentions?: Array<{ key: string; name: string; id: { open_id?: string; user_id?: string } }>,
  chatType: "p2p" | "group" = "p2p",
): FeishuMessageEvent {
  return {
    sender: { sender_id: { user_id: "u1", open_id: "ou_sender" } },
    message: {
      message_id: "msg_1",
      chat_id: "oc_chat1",
      chat_type: chatType,
      message_type: "text",
      content: JSON.stringify({ text }),
      mentions,
    },
  };
}

const BOT_OPEN_ID = "ou_bot";

describe("normalizeMentions (via parseFeishuMessageEvent)", () => {
  it.each(["p2p", "group"] as const)(
    "preserves prefix-sharing mention identities and adjacent text in %s",
    (chatType) => {
      const mentions = [
        { key: "@_user_1", name: "Bot", id: { open_id: BOT_OPEN_ID } },
        { key: "@_user_10", name: "Alice", id: { open_id: "ou_alice" } },
        { key: "@_user_11", name: "Bob", id: { open_id: "ou_bob" } },
      ];
      const originalMentions = structuredClone(mentions);
      const ctx = parseFeishuMessageEvent(
        makeEvent("@_user_1 @_user_10 @_user_11thanks", mentions, chatType),
        BOT_OPEN_ID,
      );
      expect(ctx.content).toBe(
        '<at user_id="ou_alice">Alice</at> <at user_id="ou_bob">Bob</at>thanks',
      );
      expect(ctx.mentionedBot).toBe(true);
      expect(ctx.mentionTargets?.map((target) => target.openId)).toEqual(["ou_alice", "ou_bob"]);
      expect(mentions).toEqual(originalMentions);
    },
  );

  it("keeps placeholder-like display names literal", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_10 @_user_1", [
        { key: "@_user_10", name: "Alice @_user_1", id: { open_id: "ou_alice" } },
        { key: "@_user_1", name: "Bob", id: { open_id: "ou_bob" } },
      ]),
    );
    expect(ctx.content).toBe(
      '<at user_id="ou_alice">Alice @_user_1</at> <at user_id="ou_bob">Bob</at>',
    );
  });

  it("classifies Feishu bot senders without changing legacy sender defaults", () => {
    const botEvent = makeEvent("hello");
    botEvent.sender.sender_type = "bot";

    expect(parseFeishuMessageEvent(botEvent, BOT_OPEN_ID).senderType).toBe("bot");
    expect(parseFeishuMessageEvent(makeEvent("hello"), BOT_OPEN_ID).senderType).toBe("user");
  });

  it("returns original text when mentions are missing", () => {
    const ctx = parseFeishuMessageEvent(makeEvent("hello world", undefined), BOT_OPEN_ID);
    expect(ctx.content).toBe("hello world");
  });

  it("parses an empty group message body with bot-mention metadata", () => {
    const event = makeEvent(
      "",
      [{ key: "@_bot_1", name: "Bot", id: { open_id: BOT_OPEN_ID } }],
      "group",
    );
    event.message.content = "";

    expect(parseFeishuMessageEvent(event, BOT_OPEN_ID)).toMatchObject({
      content: "",
      chatType: "group",
      mentionedBot: true,
      hasAnyMention: true,
    });
  });

  it("strips bot mention in p2p (addressing prefix, not semantic content)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 hello", [{ key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("hello");
  });

  it("strips bot mention in group so slash commands work (#35994)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent(
        "@_bot_1 hello",
        [{ key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } }],
        "group",
      ),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("hello");
  });

  it("strips bot mention in group preserving slash command prefix (#35994)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent(
        "@_bot_1 /model",
        [{ key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } }],
        "group",
      ),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("/model");
  });

  it("strips bot mention but normalizes other mentions in p2p (mention-forward)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 @_user_alice hello", [
        { key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } },
        { key: "@_user_alice", name: "Alice", id: { open_id: "ou_alice" } },
      ]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe('<at user_id="ou_alice">Alice</at> hello');
  });

  it("falls back to @name when open_id is absent", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 hi", [{ key: "@_user_1", name: "Alice", id: { user_id: "uid_alice" } }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("@Alice hi");
  });

  it("falls back to plain @name when no id is present", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_unknown hey", [{ key: "@_unknown", name: "Nobody", id: {} }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("@Nobody hey");
  });

  it("treats mention key regex metacharacters as literal text", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("hello world", [{ key: ".*", name: "Bot", id: { open_id: "ou_bot" } }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("hello world");
  });

  it("normalizes multiple mentions in one pass", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 hi @_user_2", [
        { key: "@_bot_1", name: "Bot One", id: { open_id: "ou_bot_1" } },
        { key: "@_user_2", name: "User Two", id: { open_id: "ou_user_2" } },
      ]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe(
      '<at user_id="ou_bot_1">Bot One</at> hi <at user_id="ou_user_2">User Two</at>',
    );
  });

  it("treats $ in display name as literal (no replacement-pattern interpolation)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 hi", [{ key: "@_user_1", name: "$& the user", id: { open_id: "ou_x" } }]),
      BOT_OPEN_ID,
    );
    // $ is preserved literally (no $& pattern substitution); & is not escaped in tag body
    expect(ctx.content).toBe('<at user_id="ou_x">$& the user</at> hi');
  });

  it("escapes < and > in mention name to protect tag structure", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 test", [{ key: "@_user_1", name: "<script>", id: { open_id: "ou_x" } }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe('<at user_id="ou_x">&lt;script&gt;</at> test');
  });
});
