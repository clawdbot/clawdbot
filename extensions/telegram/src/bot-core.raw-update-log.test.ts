// Telegram tests cover bot core.raw update log plugin behavior.
import { describe, expect, it } from "vitest";
import { formatTelegramRawUpdateForLog } from "./raw-update-log.js";

describe("formatTelegramRawUpdateForLog", () => {
  it("redacts private Telegram raw update fields before verbose logging", () => {
    const update = {
      update_id: 98765,
      message: {
        message_id: 44,
        from: {
          id: 123456,
          is_bot: false,
          first_name: "Alice",
          last_name: "Example",
          username: "alice_private",
          language_code: "en-US",
          is_premium: true,
        },
        chat: {
          id: -1001234567890,
          type: "private",
          title: "Private Chat",
          username: "private_chat",
        },
        text: "please inspect https://private.example/secret",
        entities: [{ type: "url", offset: 15, length: 30, url: "https://private.example/entity" }],
        link_preview_options: { url: "https://private.example/preview" },
        new_chat_members: [
          {
            id: 246810,
            is_bot: false,
            first_name: "New",
            last_name: "Member",
            username: "new_member_user",
            language_code: "fr-CA",
            added_to_attachment_menu: true,
          },
        ],
      },
      callback_query: {
        id: "callback-id",
        from: { id: 7777, first_name: "Bob", username: "bob_private" },
        data: "sensitive callback payload",
      },
    };

    const rawLog = formatTelegramRawUpdateForLog(update);

    expect(rawLog).toContain('"update_id":98765');
    expect(rawLog).toContain('"message_id":44');
    expect(rawLog).toContain('"text":"[redacted]"');
    expect(rawLog).toContain('"url":"[redacted]"');
    for (const privateValue of [
      "123456",
      "-1001234567890",
      "Alice",
      "Example",
      "alice_private",
      "en-US",
      "Private Chat",
      "private_chat",
      "please inspect",
      "https://private.example",
      "246810",
      "New",
      "Member",
      "new_member_user",
      "fr-CA",
      "added_to_attachment_menu",
      "7777",
      "Bob",
      "bob_private",
      "sensitive callback payload",
    ]) {
      expect(rawLog).not.toContain(privateValue);
    }
  });

  it("redacts identifiers from less common Telegram update shapes", () => {
    const update = {
      update_id: 45678,
      business_connection: {
        id: "business-connection-id",
        user: {
          id: 111222,
          is_bot: false,
          first_name: "Business",
          username: "business_user",
        },
        user_chat_id: 333444,
        date: 1712345678,
        can_reply: true,
        is_enabled: true,
      },
      chat_join_request: {
        chat: {
          id: -100555666,
          type: "supergroup",
          title: "Join Request Group",
          username: "join_request_group",
        },
        from: {
          id: 777888,
          is_bot: false,
          first_name: "Joiner",
          username: "join_user",
        },
        user_chat_id: 999000,
        date: 1712345679,
        bio: "private bio",
        invite_link: {
          invite_link: "https://t.me/+private-invite",
          creator: {
            id: 222333,
            is_bot: false,
            first_name: "Creator",
            username: "invite_creator",
          },
        },
      },
      message_reaction: {
        chat: {
          id: -100111222,
          type: "supergroup",
          title: "Reaction Group",
        },
        message_id: 99,
        actor_chat: {
          id: -100333444,
          type: "channel",
          title: "Actor Channel",
          username: "actor_channel",
        },
        date: 1712345680,
        old_reaction: [],
        new_reaction: [],
      },
    };

    const rawLog = formatTelegramRawUpdateForLog(update);

    expect(rawLog).toContain('"update_id":45678');
    expect(rawLog).toContain('"message_id":99');
    expect(rawLog).toContain('"can_reply":true');
    expect(rawLog).toContain('"is_enabled":true');
    expect(rawLog).toContain('"user_chat_id":"[redacted]"');
    expect(rawLog).toContain('"id":"[redacted]"');
    for (const privateValue of [
      "business-connection-id",
      "111222",
      "Business",
      "business_user",
      "333444",
      "-100555666",
      "Join Request Group",
      "join_request_group",
      "777888",
      "Joiner",
      "join_user",
      "999000",
      "private bio",
      "https://t.me/+private-invite",
      "222333",
      "Creator",
      "invite_creator",
      "-100111222",
      "Reaction Group",
      "-100333444",
      "Actor Channel",
      "actor_channel",
    ]) {
      expect(rawLog).not.toContain(privateValue);
    }
  });

  it("truncates long raw update strings without splitting UTF-16 surrogate pairs", () => {
    const prefix = "a".repeat(499);
    const rawLog = formatTelegramRawUpdateForLog({
      update_id: 123,
      diagnostic: `${prefix}\uD83D\uDE80tail`,
    });
    const parsed = JSON.parse(rawLog) as { diagnostic: string };

    expect(parsed.diagnostic).toBe(`${prefix}...`);
    expect(parsed.diagnostic).not.toContain("\uD83D");
    expect(parsed.diagnostic).not.toContain("\uDE80");
    expect(rawLog).not.toContain("\\ud83d");
    expect(rawLog).not.toContain("\\ude80");
  });

  it("truncates the complete raw update log without splitting surrogate pairs", () => {
    const keyPrefix = "x".repeat(7997);
    const rawLog = formatTelegramRawUpdateForLog({ [`${keyPrefix}😀tail`]: 1 });

    expect(rawLog).toBe(`{"${keyPrefix}...`);
    expect(rawLog).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});
