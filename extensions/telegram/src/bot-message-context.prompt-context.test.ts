import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGroupHistoryKey } from "openclaw/plugin-sdk/routing";
import {
  getSessionEntry,
  readAmbientTranscriptWatermark,
  resolveAmbientTranscriptWatermarkKey,
  updateAmbientTranscriptWatermark,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";

function firstChatWindowMessages(
  ctx: Awaited<ReturnType<typeof buildTelegramMessageContextForTest>>,
): Array<Record<string, unknown>> {
  const entry = ctx?.ctxPayload.ChannelStructuredContext?.find(
    (item) => item.type === "chat_window",
  );
  const payload = entry?.payload as { messages: Array<Record<string, unknown>> } | undefined;
  return payload?.messages ?? [];
}

const telegramChatWindowContext: TelegramPromptContextEntry = {
  label: "Conversation context",
  source: "telegram",
  type: "chat_window",
  payload: {
    order: "chronological",
    relation: "selected_for_current_message",
    messages: [
      {
        message_id: "10",
        sender: "Pat",
        timestamp_ms: 1_700_000_000_000,
        body: "Earlier DM turn already in the transcript",
      },
    ],
  },
};

const tempDirs: string[] = [];

function createTempSessionStorePath(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-watermark-"));
  tempDirs.push(tempDir);
  return path.join(tempDir, "sessions.json");
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("buildTelegramMessageContext prompt context", () => {
  it("omits Telegram chat-window context for existing unthreaded private DM sessions", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 1234, type: "private", first_name: "Pat" },
        from: { id: 1234, first_name: "Pat" },
        text: "continue",
      },
      promptContext: [telegramChatWindowContext],
      sessionRuntime: {
        readSessionUpdatedAt: ({ sessionKey }) =>
          sessionKey === "agent:main:main" ? 1_700_000_000_000 : undefined,
      },
    });

    expect(ctx?.ctxPayload.SessionKey).toBe("agent:main:main");
    expect(ctx?.ctxPayload.ChannelStructuredContext).toBeUndefined();
  });

  it("keeps Telegram chat-window context for fresh private DM sessions", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 1234, type: "private", first_name: "Pat" },
        from: { id: 1234, first_name: "Pat" },
        text: "start",
      },
      promptContext: [telegramChatWindowContext],
    });

    expect(ctx?.ctxPayload.ChannelStructuredContext).toEqual([telegramChatWindowContext]);
  });

  it("keeps Telegram chat-window context for existing private DM replies", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 1234, type: "private", first_name: "Pat" },
        from: { id: 1234, first_name: "Pat" },
        text: "replying with context",
        reply_to_message: {
          chat: { id: 1234, type: "private", first_name: "Pat" },
          from: { id: 1234, first_name: "Pat" },
          text: "older referenced turn",
          date: 1_700_000_000,
          message_id: 10,
        },
      },
      promptContext: [telegramChatWindowContext],
      sessionRuntime: {
        readSessionUpdatedAt: ({ sessionKey }) =>
          sessionKey === "agent:main:main" ? 1_700_000_000_000 : undefined,
      },
    });

    expect(ctx?.ctxPayload.ChannelStructuredContext).toEqual([telegramChatWindowContext]);
  });

  it("preserves richer chat-window fields when merging duplicate group history", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 11,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
        from: { id: 1234, first_name: "Pat" },
        text: "@bot continue",
        entities: [{ type: "mention", offset: 0, length: 4 }],
        message_thread_id: 99,
      },
      historyLimit: 10,
      groupHistories: new Map([
        [
          "-1001234567890:topic:99",
          [
            {
              messageId: "10",
              sender: "Pat",
              timestamp: 1_700_000_000_000,
              body: "Earlier with media",
            },
          ],
        ],
      ]),
      promptContext: [
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          payload: {
            order: "chronological",
            relation: "selected_for_current_message",
            messages: [
              {
                message_id: "10",
                sender: "Pat",
                timestamp_ms: 1_700_000_000_000,
                body: "Earlier with media",
                is_reply_target: true,
                media_type: "image/png",
                media_path: "media://inbound/screenshot.png",
              },
            ],
          },
        },
      ],
    });

    // The freshly-derived scoped history message and the richer pre-existing message
    // share the same message_id key; mergeTelegramGroupHistoryPromptContext must merge
    // them field-by-field instead of letting whichever side is processed last overwrite
    // the other wholesale, or the conversation_scope needed by the CLI resume watermark
    // (src/agents/cli-runner/prepare.ts) silently disappears whenever richer prior
    // context (reply targets, media) already occupies that key.
    expect(ctx?.ctxPayload.ChannelStructuredContext).toEqual([
      expect.objectContaining({
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [
            expect.objectContaining({
              message_id: "10",
              conversation_scope: buildGroupHistoryKey({
                channel: "telegram",
                accountId: "default",
                peerKind: "group",
                peerId: "-1001234567890:topic:99",
              }),
              is_reply_target: true,
              media_type: "image/png",
              media_path: "media://inbound/screenshot.png",
            }),
          ],
        }),
      }),
    ]);
  });

  it("scopes group history message keys by chat/topic so cross-chat message ids never collide", async () => {
    // Telegram message_id is chat-local. A reusable native CLI session can be shared by
    // more than one configured route, so message #10 in one chat and message #10 in a
    // different chat must project distinct conversation_scope values; otherwise the CLI
    // resume watermark (src/agents/cli-runner/prepare.ts) would treat chat B's message as
    // already delivered once chat A's message #10 is recorded.
    const buildGroupTurn = (chatId: number, historyKeyEntry: string) =>
      buildTelegramMessageContextForTest({
        message: {
          message_id: 20,
          chat: { id: chatId, type: "supergroup", title: "Group" },
          from: { id: 1234, first_name: "Pat" },
          text: "@bot continue",
          entities: [{ type: "mention", offset: 0, length: 4 }],
        },
        historyLimit: 10,
        groupHistories: new Map([
          [
            historyKeyEntry,
            [
              {
                messageId: "10",
                sender: "Pat",
                timestamp: 1_700_000_000_000,
                body: "shared numeric id",
              },
            ],
          ],
        ]),
      });

    const chatA = await buildGroupTurn(-1001111111111, "-1001111111111");
    const chatB = await buildGroupTurn(-1002222222222, "-1002222222222");

    const chatAScope = firstChatWindowMessages(chatA)[0]?.["conversation_scope"];
    const chatBScope = firstChatWindowMessages(chatB)[0]?.["conversation_scope"];
    expect(firstChatWindowMessages(chatA)[0]?.["message_id"]).toBe("10");
    expect(firstChatWindowMessages(chatB)[0]?.["message_id"]).toBe("10");
    expect(chatAScope).toBeDefined();
    expect(chatBScope).toBeDefined();
    expect(chatAScope).not.toBe(chatBScope);
  });

  it("scopes group history message keys by topic so one chat's topics never collide", async () => {
    // Same regression as the cross-chat case, but within a single forum chat: two topics
    // sharing Telegram's chat-local message_id "10" must still project distinct
    // conversation_scope values, since buildTelegramGroupPeerId scopes historyKey by
    // chat+topic and that historyKey feeds the conversation_scope fold in
    // src/auto-reply/reply/inbound-meta.ts.
    const buildTopicTurn = (topicId: number) =>
      buildTelegramMessageContextForTest({
        message: {
          message_id: 30,
          chat: { id: -1003333333333, type: "supergroup", title: "Forum", is_forum: true },
          from: { id: 1234, first_name: "Pat" },
          text: "@bot continue",
          entities: [{ type: "mention", offset: 0, length: 4 }],
          message_thread_id: topicId,
        },
        historyLimit: 10,
        groupHistories: new Map([
          [
            `-1003333333333:topic:${topicId}`,
            [
              {
                messageId: "10",
                sender: "Pat",
                timestamp: 1_700_000_000_000,
                body: "shared numeric id",
              },
            ],
          ],
        ]),
      });

    const topicOne = await buildTopicTurn(101);
    const topicTwo = await buildTopicTurn(202);

    const topicOneScope = firstChatWindowMessages(topicOne)[0]?.["conversation_scope"];
    const topicTwoScope = firstChatWindowMessages(topicTwo)[0]?.["conversation_scope"];
    expect(firstChatWindowMessages(topicOne)[0]?.["message_id"]).toBe("10");
    expect(firstChatWindowMessages(topicTwo)[0]?.["message_id"]).toBe("10");
    expect(topicOneScope).toBeDefined();
    expect(topicTwoScope).toBeDefined();
    expect(topicOneScope).not.toBe(topicTwoScope);
  });

  it("excludes ambient transcript rows from the group history window", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 13,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum" },
        from: { id: 1234, first_name: "Pat" },
        text: "@bot what happened?",
        entities: [{ type: "mention", offset: 0, length: 4 }],
      },
      historyLimit: 10,
      groupHistories: new Map([
        [
          "-1001234567890",
          [
            {
              messageId: "10",
              sender: "Sam",
              timestamp: 1_700_000_000_000,
              body: "persisted ambient one",
            },
            {
              messageId: "11",
              sender: "Lee",
              timestamp: 1_700_000_001_000,
              body: "persisted ambient two",
            },
            {
              messageId: "12",
              sender: "Mira",
              timestamp: 1_700_000_002_000,
              body: "unpersisted gap",
            },
          ],
        ],
      ]),
      sessionRuntime: {
        readAmbientTranscriptWatermark: ({ key }) =>
          key === '["telegram","default","-1001234567890",""]'
            ? {
                sessionId: "session-current",
                messageId: "11",
                timestampMs: 1_700_000_001_000,
                updatedAt: 1_700_000_003_000,
              }
            : undefined,
      },
    });

    expect(ctx?.ctxPayload.ChannelStructuredContext).toEqual([
      expect.objectContaining({
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [
            expect.objectContaining({
              message_id: "12",
              body: "unpersisted gap",
            }),
          ],
        }),
      }),
    ]);
    expect(JSON.stringify(ctx?.ctxPayload.ChannelStructuredContext)).not.toContain(
      "persisted ambient",
    );
  });

  it("drops stale cached voice and media context before rebuilding group history", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 12,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum" },
        from: { id: 1234, first_name: "Pat" },
        text: "@bot continue",
        entities: [{ type: "mention", offset: 0, length: 4 }],
      },
      historyLimit: 10,
      groupHistories: new Map([
        [
          "-1001234567890",
          [
            {
              messageId: "11",
              sender: "Pat",
              timestamp: 1_700_000_001_000,
              body: "latest retained turn",
            },
          ],
        ],
      ]),
      promptContext: [
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          payload: {
            order: "chronological",
            relation: "selected_for_current_message",
            messages: [
              {
                message_id: "10",
                sender: "Pat",
                body: "old voice transcript",
                media_type: "audio/ogg",
                media_ref: "telegram:file/old-voice",
              },
            ],
          },
        },
      ],
    });

    const rendered = JSON.stringify(ctx?.ctxPayload.ChannelStructuredContext);
    expect(rendered).toContain("latest retained turn");
    expect(rendered).not.toContain("old voice transcript");
    expect(rendered).not.toContain("telegram:file/old-voice");
  });

  it("applies the ambient watermark before truncating the history window", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 13,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum" },
        from: { id: 1234, first_name: "Pat" },
        text: "@bot what happened?",
        entities: [{ type: "mention", offset: 0, length: 4 }],
      },
      historyLimit: 1,
      groupHistories: new Map([
        [
          "-1001234567890",
          [
            {
              messageId: "12",
              sender: "Mira",
              timestamp: 1_700_000_002_000,
              body: "unpersisted gap",
            },
            {
              messageId: "11",
              sender: "Lee",
              timestamp: 1_700_000_001_000,
              body: "late persisted ambient",
            },
          ],
        ],
      ]),
      sessionRuntime: {
        readAmbientTranscriptWatermark: () => ({
          sessionId: "session-current",
          messageId: "11",
          timestampMs: 1_700_000_001_000,
          updatedAt: 1_700_000_003_000,
        }),
      },
    });

    expect(ctx?.ctxPayload.InboundHistory).toEqual([
      expect.objectContaining({ messageId: "12", body: "unpersisted gap" }),
    ]);
  });

  it("omits transcript-owned ambient rows from steady-state room-event prompt text", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 12,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum" },
        from: { id: 1234, first_name: "Pat" },
        text: "current ambient",
        date: 1_700_000_002,
      },
      cfg: {
        messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } },
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      },
      historyLimit: 10,
      groupHistories: new Map([
        [
          "-1001234567890",
          [
            {
              messageId: "10",
              sender: "Sam",
              timestamp: 1_700_000_000_000,
              body: "persisted ambient one",
            },
            {
              messageId: "11",
              sender: "Lee",
              timestamp: 1_700_000_001_000,
              body: "persisted ambient two",
            },
          ],
        ],
      ]),
      sessionRuntime: {
        readAmbientTranscriptWatermark: ({ key }) =>
          key === '["telegram","default","-1001234567890",""]'
            ? {
                sessionId: "session-current",
                messageId: "11",
                timestampMs: 1_700_000_001_000,
                updatedAt: 1_700_000_003_000,
              }
            : undefined,
      },
    });

    if (!ctx) {
      throw new Error("Expected room-event context");
    }
    expect(ctx.ctxPayload).toMatchObject({
      BodyForAgent: "current ambient",
      InboundEventKind: "room_event",
      MessageSid: "12",
      SenderName: "Pat",
    });
    expect(ctx.ctxPayload.InboundHistory).toBeUndefined();
    expect(ctx.ctxPayload.ChannelStructuredContext).toBeUndefined();
  });

  it("backfills Telegram group history when the ambient watermark belongs to a reset session", async () => {
    const storePath = createTempSessionStorePath();
    const sessionKey = "agent:main:telegram:group:-1001234567890";
    const key = resolveAmbientTranscriptWatermarkKey({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890",
    });

    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "before-reset", updatedAt: 1_700_000_000_000 },
    });
    await updateAmbientTranscriptWatermark({
      storePath,
      sessionKey,
      key,
      messageId: "11",
      timestampMs: 1_700_000_001_000,
    });
    const persistedEntry = getSessionEntry({ storePath, sessionKey });
    if (!persistedEntry) {
      throw new Error("Expected persisted session entry");
    }
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        ...persistedEntry,
        sessionId: "after-reset",
        updatedAt: 1_700_000_002_000,
      },
    });

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 13,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum" },
        from: { id: 1234, first_name: "Pat" },
        text: "@bot what happened?",
        entities: [{ type: "mention", offset: 0, length: 4 }],
      },
      historyLimit: 10,
      groupHistories: new Map([
        [
          "-1001234567890",
          [
            {
              messageId: "10",
              sender: "Sam",
              timestamp: 1_700_000_000_000,
              body: "persisted ambient one",
            },
            {
              messageId: "11",
              sender: "Lee",
              timestamp: 1_700_000_001_000,
              body: "persisted ambient two",
            },
            {
              messageId: "12",
              sender: "Mira",
              timestamp: 1_700_000_002_000,
              body: "unpersisted gap",
            },
          ],
        ],
      ]),
      sessionRuntime: {
        readAmbientTranscriptWatermark,
        resolveAmbientTranscriptWatermarkKey,
        resolveStorePath: () => storePath,
      },
    });

    expect(ctx?.ctxPayload.ChannelStructuredContext).toEqual([
      expect.objectContaining({
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [
            expect.objectContaining({ message_id: "10", body: "persisted ambient one" }),
            expect.objectContaining({ message_id: "11", body: "persisted ambient two" }),
            expect.objectContaining({ message_id: "12", body: "unpersisted gap" }),
          ],
        }),
      }),
    ]);
  });
});
