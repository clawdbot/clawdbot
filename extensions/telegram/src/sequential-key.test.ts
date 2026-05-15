import type { Chat, Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { getTelegramSequentialKey } from "./sequential-key.js";

const mockChat = (chat: Pick<Chat, "id"> & Partial<Pick<Chat, "type" | "is_forum">>): Chat =>
  chat as Chat;
const mockMessage = (message: Pick<Message, "chat"> & Partial<Message>): Message =>
  ({
    message_id: 1,
    date: 0,
    ...message,
  }) as Message;

describe("getTelegramSequentialKey", () => {
  it.each([
    [{ message: mockMessage({ chat: mockChat({ id: 123 }) }) }, "telegram:123"],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "private" }),
          message_thread_id: 9,
        }),
      },
      "telegram:123:topic:9",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup" }),
          message_thread_id: 9,
        }),
      },
      "telegram:123",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup" }),
          message_thread_id: 9,
          is_topic_message: true,
        }),
      },
      "telegram:123:topic:9",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup" }),
          is_topic_message: true,
        }),
      },
      "telegram:123:topic:1",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup", is_forum: true }),
        }),
      },
      "telegram:123:topic:1",
    ],
    [{ update: { message: mockMessage({ chat: mockChat({ id: 555 }) }) } }, "telegram:555"],
    [
      {
        channelPost: mockMessage({ chat: mockChat({ id: -100777111222, type: "channel" }) }),
      },
      "telegram:-100777111222",
    ],
    [
      {
        update: {
          channel_post: mockMessage({ chat: mockChat({ id: -100777111223, type: "channel" }) }),
        },
      },
      "telegram:-100777111223",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/stop" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/status" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/commands" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/help" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/tools" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/tasks" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/context" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/whoami" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/export-session" }) },
      "telegram:123",
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/export" }) }, "telegram:123"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/btw what is the time?" }) },
      "telegram:123:btw:1",
    ],
    [
      {
        me: { username: "openclaw_bot" } as never,
        message: mockMessage({
          chat: mockChat({ id: 123 }),
          text: "/btw@openclaw_bot what is the time?",
        }),
      },
      "telegram:123:btw:1",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "stop" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "stop please" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "do not do that" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "остановись" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "halt" }) },
      "telegram:123:control",
    ],
    [
      {
        update: {
          callback_query: {
            message: mockMessage({ chat: mockChat({ id: 123 }) }),
            data: "/approve plugin:abc123 allow-once",
          },
        },
      },
      "telegram:123:approval",
    ],
    [
      {
        update: {
          callback_query: {
            message: mockMessage({ chat: mockChat({ id: 456 }) }),
            data: "/approve exec:def456 deny",
          },
        },
      },
      "telegram:456:approval",
    ],
    [
      {
        update: {
          callback_query: {
            message: mockMessage({ chat: mockChat({ id: 789 }) }),
            data: "/approve plugin:ghi789 always",
          },
        },
      },
      "telegram:789:approval",
    ],
    [
      {
        update: {
          callback_query: {
            message: mockMessage({ chat: mockChat({ id: 123 }) }),
            data: "some-other-button",
          },
        },
      },
      "telegram:123",
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort" }) }, "telegram:123"],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort now" }) }, "telegram:123"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "please do not do that" }) },
      "telegram:123",
    ],
  ])("resolves key %#", (input, expected) => {
    expect(getTelegramSequentialKey(input)).toBe(expected);
  });
});
