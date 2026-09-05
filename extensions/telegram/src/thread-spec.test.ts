// Telegram tests cover canonical thread-scope resolution and encoding.
import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  buildTelegramInboundOriginTarget,
  buildTelegramRoutingTarget,
  buildTelegramThreadParams,
  buildTypingThreadParams,
  resolveTelegramMessageThreadSpec,
} from "./bot/helpers.js";

describe("resolveTelegramMessageThreadSpec", () => {
  it.each([
    {
      name: "bot-private topic",
      message: { chat: { id: 123, type: "private" }, message_thread_id: 42 },
      expected: { id: 42, scope: "dm" },
    },
    {
      name: "forum topic from message hint",
      message: {
        chat: { id: -100123, type: "supergroup" },
        is_topic_message: true,
        message_thread_id: 99,
      },
      expected: { id: 99, scope: "forum" },
    },
    {
      name: "forum General topic",
      message: { chat: { id: -100123, type: "supergroup", is_forum: true } },
      expected: { id: 1, scope: "forum" },
    },
    {
      name: "channel Direct Messages topic",
      message: {
        chat: { id: -100123, type: "supergroup", is_direct_messages: true },
        direct_messages_topic: { topic_id: 77 },
        message_thread_id: 999,
      },
      expected: { id: 77, scope: "direct-messages" },
    },
    {
      name: "invalid channel Direct Messages evidence",
      message: {
        chat: { id: -100123, type: "supergroup", is_direct_messages: true },
        direct_messages_topic: { topic_id: 0 },
        message_thread_id: 77,
      },
      expected: { scope: "none" },
    },
    {
      name: "regular group without topic proof",
      message: { chat: { id: -100123, type: "supergroup" }, message_thread_id: 42 },
      expected: { scope: "none" },
    },
  ])("resolves $name", ({ message, expected }) => {
    expect(resolveTelegramMessageThreadSpec(message as Message)).toEqual(expected);
  });
});

describe("buildTelegramThreadParams", () => {
  it.each([
    { input: { id: 1, scope: "forum" as const }, expected: undefined },
    { input: { id: 99, scope: "forum" as const }, expected: { message_thread_id: 99 } },
    { input: { id: 2, scope: "dm" as const }, expected: { message_thread_id: 2 } },
    {
      input: { id: 77, scope: "direct-messages" as const },
      expected: { direct_messages_topic_id: 77 },
    },
    { input: { id: -1, scope: "direct-messages" as const }, expected: undefined },
    { input: { id: 42.9, scope: "forum" as const }, expected: { message_thread_id: 42 } },
  ])("builds thread params", ({ input, expected }) => {
    expect(buildTelegramThreadParams(input)).toEqual(expected);
  });
});

describe("buildTelegramRoutingTarget", () => {
  it.each([
    {
      name: "keeps General forum topic chat-scoped",
      chatId: -100123,
      thread: { id: 1, scope: "forum" as const },
      expected: "telegram:-100123",
    },
    {
      name: "includes real forum topic ids",
      chatId: -100123,
      thread: { id: 42, scope: "forum" as const },
      expected: "telegram:-100123:topic:42",
    },
    {
      name: "includes channel Direct Messages topic ids with a distinct marker",
      chatId: -100123,
      thread: { id: 77, scope: "direct-messages" as const },
      expected: "telegram:-100123:direct-topic:77",
    },
  ])("$name", ({ chatId, thread, expected }) => {
    expect(buildTelegramRoutingTarget(chatId, thread)).toBe(expected);
  });
});

describe("buildTelegramInboundOriginTarget", () => {
  it.each([
    {
      name: "keeps bot-private topic thread ids out of the origin target",
      chatId: 42,
      thread: { id: 77, scope: "dm" as const },
      expected: "telegram:42",
    },
    {
      name: "includes real forum topic ids",
      chatId: -100123,
      thread: { id: 42, scope: "forum" as const },
      expected: "telegram:-100123:topic:42",
    },
    {
      name: "includes channel Direct Messages topics",
      chatId: -100123,
      thread: { id: 77, scope: "direct-messages" as const },
      expected: "telegram:-100123:direct-topic:77",
    },
  ])("$name", ({ chatId, thread, expected }) => {
    expect(buildTelegramInboundOriginTarget(chatId, thread)).toBe(expected);
  });
});

describe("buildTypingThreadParams", () => {
  it.each([
    { input: undefined, expected: undefined },
    { input: 1, expected: { message_thread_id: 1 } },
    { input: 42.9, expected: { message_thread_id: 42 } },
  ])("builds typing params", ({ input, expected }) => {
    expect(buildTypingThreadParams(input)).toEqual(expected);
  });
});
