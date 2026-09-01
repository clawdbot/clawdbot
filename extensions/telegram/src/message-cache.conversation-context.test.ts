// Telegram tests cover message cache plugin behavior.
import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { isTelegramHistoryEntryAfterAmbientWatermark } from "./group-history-window.js";
import {
  buildTelegramConversationContext,
  buildTelegramReplyChain,
  createTelegramMessageCache,
} from "./message-cache.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest as resetTelegramMessageCacheBucketsForTest,
} from "./runtime.test-support.js";

describe("telegram message cache conversation context", () => {
  it("returns recent chat messages before the current message", async () => {
    const cache = createTelegramMessageCache();
    for (const id of [41, 42, 43, 44]) {
      await cache.record({
        accountId: "default",
        chatId: 7,
        threadId: 100,
        msg: {
          chat: { id: 7, type: "supergroup", title: "Ops" },
          message_thread_id: 100,
          message_id: id,
          date: 1736380700 + id,
          text: `live message ${id}`,
          from: { id, is_bot: false, first_name: `User ${id}` },
        } as Message,
      });
    }
    await cache.record({
      accountId: "default",
      chatId: 7,
      threadId: 200,
      msg: {
        chat: { id: 7, type: "supergroup", title: "Ops" },
        message_thread_id: 200,
        message_id: 142,
        date: 1736380743,
        text: "different topic",
        from: { id: 99, is_bot: false, first_name: "Other" },
      } as Message,
    });

    const recent = await cache.recentBefore({
      accountId: "default",
      chatId: 7,
      threadId: 100,
      messageId: "44",
      limit: 2,
    });
    expect(recent.map((entry) => entry.messageId)).toEqual(["42", "43"]);
  });

  it("preserves rich-message placeholders in subsequent conversation context", async () => {
    // A runtime leaked by earlier suite files binds new caches to the
    // persistent keyed store; clear it so this cache stays instance-local.
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheBucketsForTest();
    const cache = createTelegramMessageCache();
    const chat = { id: 7, type: "private", first_name: "Nora" } as const;
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 45,
        date: 1736380745,
        rich_message: { blocks: [{ type: "paragraph" }] },
        from: { id: 1, is_bot: false, first_name: "Nora" },
      } as Message,
    });
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 46,
        date: 1736380746,
        text: "What did I just send?",
        from: { id: 1, is_bot: false, first_name: "Nora" },
      } as Message,
    });

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "46",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 2,
    });

    expect(context).toHaveLength(1);
    expect(context[0]?.node).toMatchObject({
      messageId: "45",
      body: "[unsupported Telegram rich_message received]",
    });
  });

  it("preserves rich-message text in subsequent conversation context", async () => {
    // A runtime leaked by earlier suite files binds new caches to the
    // persistent keyed store; clear it so this cache stays instance-local.
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheBucketsForTest();
    const cache = createTelegramMessageCache();
    const chat = { id: 7, type: "private", first_name: "Nora" } as const;
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 45,
        date: 1736380745,
        rich_message: {
          blocks: [
            {
              type: "paragraph",
              text: "Forwarded cache text",
            },
          ],
        },
        from: { id: 1, is_bot: false, first_name: "Nora" },
      } as Message,
    });
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 46,
        date: 1736380746,
        text: "What did I just send?",
        from: { id: 1, is_bot: false, first_name: "Nora" },
      } as Message,
    });

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "46",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 2,
    });

    expect(context).toHaveLength(1);
    expect(context[0]?.node).toMatchObject({
      messageId: "45",
      body: "Forwarded cache text",
    });
  });

  it("returns nearby messages around a stale reply target", async () => {
    const cache = createTelegramMessageCache();
    for (const id of [100, 101, 102, 200, 201]) {
      await cache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "group", title: "Ops" },
          message_id: id,
          date: 1736380700 + id,
          text: `message ${id}`,
          from: { id, is_bot: false, first_name: `User ${id}` },
        } as Message,
      });
    }

    const nearby = await cache.around({
      accountId: "default",
      chatId: 7,
      messageId: "101",
      before: 1,
      after: 1,
    });
    expect(nearby.map((entry) => entry.messageId)).toEqual(["100", "101", "102"]);
  });

  it("selects reply targets referenced by the current local window", async () => {
    const cache = createTelegramMessageCache();
    for (const id of [33867, 33868, 33869]) {
      await cache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "group", title: "Ops" },
          message_id: id,
          date: 1736380000 + id,
          text: `old context ${id}`,
          from: { id, is_bot: false, first_name: `Old ${id}` },
        } as Message,
      });
    }
    for (let id = 34460; id <= 34475; id++) {
      await cache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "group", title: "Ops" },
          message_id: id,
          date: 1736380000 + id,
          text: `recent context ${id}`,
          from: { id, is_bot: false, first_name: `Recent ${id}` },
        } as Message,
      });
    }
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "group", title: "Ops" },
        message_id: 34476,
        date: 1736380000 + 34476,
        text: "@HamVerBot what about now",
        from: { id: 34476, is_bot: false, first_name: "Ayaan" },
        reply_to_message: {
          chat: { id: 7, type: "group", title: "Ops" },
          message_id: 33868,
          date: 1736380000 + 33868,
          text: "old context 33868",
          from: { id: 33868, is_bot: false, first_name: "Old 33868" },
        } as Message["reply_to_message"],
      } as Message,
    });
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "group", title: "Ops" },
        message_id: 34477,
        date: 1736380000 + 34477,
        text: "Show me raw input",
        from: { id: 34477, is_bot: false, first_name: "Ayaan" },
      } as Message,
    });

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "34477",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 1,
    });

    expect(context.map((entry) => entry.node.messageId)).toEqual([
      "33867",
      "33868",
      "33869",
      "34467",
      "34468",
      "34469",
      "34470",
      "34471",
      "34472",
      "34473",
      "34474",
      "34475",
      "34476",
    ]);
    expect(context.find((entry) => entry.node.messageId === "33868")?.isReplyTarget).toBe(true);
    expect(context.find((entry) => entry.node.messageId === "34477")).toBeUndefined();
  });

  it("filters conversation context nodes when an include predicate is supplied", async () => {
    const cache = createTelegramMessageCache();
    const chat = { id: 7, type: "group", title: "Ops" } as const;
    for (const msg of [
      {
        chat,
        message_id: 600,
        date: 1736380600,
        text: "ambient setup chatter",
        from: { id: 111, is_bot: false, first_name: "Requester" },
      },
      {
        chat,
        message_id: 601,
        date: 1736380660,
        text: "@openclaw_bot please check this",
        from: { id: 222, is_bot: false, first_name: "Operator" },
      },
      {
        chat,
        message_id: 602,
        date: 1736380720,
        text: "@openclaw_bot Hello",
        from: { id: 222, is_bot: false, first_name: "Operator" },
      },
    ] satisfies Message[]) {
      await cache.record({ accountId: "default", chatId: 7, msg });
    }

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "602",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 1,
      includeNode: (node) => node.body?.includes("@openclaw_bot") === true,
    });

    expect(context.map((entry) => entry.node.messageId)).toEqual(["601"]);
  });

  it("filters ambient transcript rows from cache-derived group context", async () => {
    const cache = createTelegramMessageCache();
    const chat = { id: 7, type: "group", title: "Ops" } as const;
    const timestampMs = 1_700_000_000_000;
    for (const msg of [
      {
        chat,
        message_id: 10,
        date: timestampMs / 1000,
        text: "persisted ambient one",
        from: { id: 101, is_bot: false, first_name: "Sam" },
      },
      {
        chat,
        message_id: 11,
        date: (timestampMs + 1000) / 1000,
        text: "persisted ambient two",
        from: { id: 102, is_bot: false, first_name: "Lee" },
      },
      {
        chat,
        message_id: 12,
        date: (timestampMs + 2000) / 1000,
        text: "unpersisted gap",
        from: { id: 103, is_bot: false, first_name: "Mira" },
        reply_to_message: {
          chat,
          message_id: 11,
          date: (timestampMs + 1000) / 1000,
          text: "persisted ambient two",
          from: { id: 102, is_bot: false, first_name: "Lee" },
        } as Message["reply_to_message"],
      },
      {
        chat,
        message_id: 13,
        date: (timestampMs + 3000) / 1000,
        text: "@openclaw_bot what happened?",
        from: { id: 104, is_bot: false, first_name: "Pat" },
      },
    ] satisfies Message[]) {
      await cache.record({ accountId: "default", chatId: 7, msg });
    }

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "13",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 1,
      includeNode: (node, flags) =>
        flags?.replyTarget === true ||
        isTelegramHistoryEntryAfterAmbientWatermark(node, {
          messageId: "11",
          timestampMs: timestampMs + 1000,
        }),
    });

    expect(context.map((entry) => entry.node.messageId)).toEqual(["11", "12"]);
    expect(context.find((entry) => entry.node.messageId === "11")?.isReplyTarget).toBe(true);
    expect(context.map((entry) => entry.node.body)).not.toContain("persisted ambient one");
    expect(context.map((entry) => entry.node.body)).toContain("unpersisted gap");
  });

  it("does not select messages before the latest session reset command", async () => {
    const cache = createTelegramMessageCache();
    const beforeSession = Date.parse("2026-05-10T12:40:00.000Z");
    const sessionStartedAt = Date.parse("2026-05-10T17:30:43.980Z");
    const afterSession = Date.parse("2026-05-11T23:36:00.000Z");
    const staleInstruction = "okay so we just flip in openclaw? if yes do it up";
    const record = (params: {
      id: number;
      text: string;
      timestampMs: number;
      replyTo?: { id: number; text: string; timestampMs: number };
    }) =>
      cache.record({
        accountId: "default",
        chatId: 7,
        threadId: 22534,
        msg: {
          chat: { id: 7, type: "supergroup", title: "Ops", is_forum: true },
          message_thread_id: 22534,
          message_id: params.id,
          date: Math.floor(params.timestampMs / 1000),
          text: params.text,
          from: { id: params.id, is_bot: false, first_name: "Requester" },
          ...(params.replyTo
            ? {
                reply_to_message: {
                  chat: { id: 7, type: "supergroup", title: "Ops", is_forum: true },
                  message_thread_id: 22534,
                  message_id: params.replyTo.id,
                  date: Math.floor(params.replyTo.timestampMs / 1000),
                  text: params.replyTo.text,
                  from: { id: params.replyTo.id, is_bot: false, first_name: "Requester" },
                } as Message["reply_to_message"],
              }
            : {}),
        } as Message,
      });

    await record({ id: 84669, text: "earlier topic setup", timestampMs: beforeSession - 1000 });
    await record({ id: 84670, text: staleInstruction, timestampMs: beforeSession });
    await record({ id: 84671, text: "old reply context", timestampMs: beforeSession + 1000 });
    await record({ id: 85000, text: "/new", timestampMs: sessionStartedAt });
    await record({
      id: 87183,
      text: "post-reset context",
      timestampMs: afterSession - 60_000,
      replyTo: { id: 84670, text: staleInstruction, timestampMs: beforeSession },
    });
    await record({
      id: 87184,
      text: "how does this determine stability?",
      timestampMs: afterSession,
    });

    const replyChainNodes = await buildTelegramReplyChain({
      cache,
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "supergroup", title: "Ops", is_forum: true },
        message_thread_id: 22534,
        message_id: 87185,
        date: Math.floor(afterSession / 1000) + 30,
        text: "follow up",
        from: { id: 87185, is_bot: false, first_name: "Requester" },
        reply_to_message: {
          chat: { id: 7, type: "supergroup", title: "Ops", is_forum: true },
          message_thread_id: 22534,
          message_id: 84670,
          date: Math.floor(beforeSession / 1000),
          text: staleInstruction,
          from: { id: 84670, is_bot: false, first_name: "Requester" },
        } as Message["reply_to_message"],
      } as Message,
    });

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "87185",
      threadId: 22534,
      replyChainNodes,
      recentLimit: 10,
      replyTargetWindowSize: 1,
    });

    expect(context.map((entry) => entry.node.messageId)).toEqual(["87183", "87184"]);
    expect(context.map((entry) => entry.node.body)).not.toContain(staleInstruction);
  });

  it("uses the current reset command as the session boundary", async () => {
    const cache = createTelegramMessageCache();
    const chat = { id: 7, type: "group", title: "Ops" } as const;
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 100,
        date: 1736380800,
        text: "stale context",
        from: { id: 100, is_bot: false, first_name: "Requester" },
      } as Message,
    });
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 101,
        date: 1736380860,
        text: "/new",
        from: { id: 101, is_bot: false, first_name: "Requester" },
      } as Message,
    });

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "101",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 1,
    });

    expect(context).toEqual([]);
  });

  it("does not select messages before the persisted session start when the reset command is absent", async () => {
    const cache = createTelegramMessageCache();
    const beforeSession = Date.parse("2026-05-10T12:40:00.000Z");
    const sessionStartedAt = Date.parse("2026-05-10T17:30:43.127Z");
    const afterSession = Date.parse("2026-05-11T23:36:00.000Z");
    const staleInstruction = "okay so we just flip in openclaw? if yes do it up";
    const record = (params: {
      id: number;
      text: string;
      timestampMs: number;
      replyTo?: { id: number; text: string; timestampMs: number };
    }) =>
      cache.record({
        accountId: "default",
        chatId: -1001234567890,
        threadId: 22534,
        msg: {
          chat: {
            id: -1001234567890,
            type: "supergroup",
            title: "Ops",
            is_forum: true,
          },
          message_thread_id: 22534,
          message_id: params.id,
          date: Math.floor(params.timestampMs / 1000),
          text: params.text,
          from: { id: 101, is_bot: false, first_name: "Requester" },
          ...(params.replyTo
            ? {
                reply_to_message: {
                  chat: {
                    id: -1001234567890,
                    type: "supergroup",
                    title: "Ops",
                    is_forum: true,
                  },
                  message_thread_id: 22534,
                  message_id: params.replyTo.id,
                  date: Math.floor(params.replyTo.timestampMs / 1000),
                  text: params.replyTo.text,
                  from: { id: 101, is_bot: false, first_name: "Requester" },
                } as Message["reply_to_message"],
              }
            : {}),
        } as Message,
      });

    await record({
      id: 84649,
      text: "tools.toolSearch: true",
      timestampMs: beforeSession - 5 * 60_000,
    });
    await record({ id: 84670, text: staleInstruction, timestampMs: beforeSession });
    await record({
      id: 87184,
      text: "how does this determine stability?",
      timestampMs: afterSession,
    });
    const currentNode = await record({
      id: 87227,
      text: "what config change?",
      timestampMs: afterSession + 2 * 60 * 60_000,
      replyTo: { id: 84670, text: staleInstruction, timestampMs: beforeSession },
    });
    const current = currentNode?.sourceMessage;
    if (!current) {
      throw new Error("expected current Telegram message");
    }

    const replyChainNodes = await buildTelegramReplyChain({
      cache,
      accountId: "default",
      chatId: -1001234567890,
      msg: current,
    });
    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: -1001234567890,
      messageId: "87227",
      threadId: 22534,
      replyChainNodes,
      recentLimit: 10,
      replyTargetWindowSize: 1,
      minTimestampMs: sessionStartedAt,
    });

    expect(context.map((entry) => entry.node.messageId)).toEqual(["87184"]);
    expect(context.map((entry) => entry.node.body)).not.toContain(staleInstruction);
    expect(context.map((entry) => entry.node.body)).not.toContain("tools.toolSearch: true");
  });
});
