import { buffer } from "node:stream/consumers";
import { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramCallbackMessageActions } from "./bot-handlers.callback-actions.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { telegramPlugin } from "./channel.js";
import { asTelegramClientFetch } from "./client-fetch.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { sendTypingTelegram } from "./send-actions.js";
import { sendMessageTelegram } from "./send-message.js";
import { sendPollTelegram } from "./send-special.js";

type CapturedRequest = {
  body: Buffer;
  contentType: string;
  method: string;
};

const TOKEN = "123456:transport-payload-test";
const DIRECT_CHAT_ID = -100321;
const DIRECT_TOPIC_ID = 77;
const cfg = {
  channels: { telegram: { botToken: TOKEN } },
  session: { store: "/tmp/openclaw-telegram-transport-payload-test.json" },
} satisfies OpenClawConfig;

function directMessagesMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 41,
    date: 1_700_000_000,
    chat: {
      id: DIRECT_CHAT_ID,
      type: "supergroup",
      title: "Channel Direct Messages",
      is_direct_messages: true,
    },
    direct_messages_topic: {
      topic_id: DIRECT_TOPIC_ID,
      user: { id: 700, is_bot: false, first_name: "Subscriber" },
    },
    from: { id: 700, is_bot: false, first_name: "Subscriber" },
    text: "button",
    ...overrides,
  };
}

function installTelegramStateRuntimeForTest(): void {
  setTelegramRuntime({
    state: {
      openKeyedStore: ((options) =>
        createPluginStateKeyedStoreForTests(
          "telegram",
          options,
        )) as TelegramRuntime["state"]["openKeyedStore"],
      openSyncKeyedStore: ((options) =>
        createPluginStateSyncKeyedStoreForTests(
          "telegram",
          options,
        )) as TelegramRuntime["state"]["openSyncKeyedStore"],
    },
    channel: {},
  } as TelegramRuntime);
}

function parseJsonBody(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(request.body.toString("utf8")) as Record<string, unknown>;
}

function hasMultipartField(request: CapturedRequest, name: string, value?: string): boolean {
  const body = request.body.toString("utf8");
  const field = `name="${name}"\r\n\r\n`;
  const index = body.indexOf(field);
  if (index === -1) {
    return false;
  }
  return value === undefined || body.slice(index + field.length).startsWith(value);
}

describe("Telegram topic transport payloads", () => {
  const requests: CapturedRequest[] = [];
  let nextMessageId = 100;
  const fetch = asTelegramClientFetch(
    async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const rawBody = init?.body;
      const body =
        typeof rawBody === "string"
          ? Buffer.from(rawBody)
          : rawBody
            ? await buffer(rawBody as unknown as NodeJS.ReadableStream)
            : Buffer.alloc(0);
      const method = new URL(input instanceof Request ? input.url : String(input)).pathname
        .split("/")
        .at(-1);
      const captured = {
        body,
        contentType: new Headers(init?.headers).get("content-type") ?? "",
        method: method ?? "unknown",
      };
      requests.push(captured);

      const payload = captured.contentType.startsWith("application/json")
        ? parseJsonBody(captured)
        : undefined;
      const directTopic =
        payload?.direct_messages_topic_id ??
        (hasMultipartField(captured, "direct_messages_topic_id", String(DIRECT_TOPIC_ID))
          ? DIRECT_TOPIC_ID
          : undefined);
      const result = method?.startsWith("send")
        ? {
            message_id: nextMessageId++,
            date: 1_700_000_000,
            chat: {
              id: DIRECT_CHAT_ID,
              type: "supergroup",
              ...(directTopic !== undefined ? { is_direct_messages: true } : {}),
            },
            ...(directTopic !== undefined
              ? {
                  direct_messages_topic: {
                    topic_id: Number(directTopic),
                    user: { id: 700, is_bot: false, first_name: "Subscriber" },
                  },
                }
              : {}),
            text: "accepted",
          }
        : true;
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { "content-type": "application/json" },
      });
    },
  );
  const bot = new Bot(TOKEN, { client: { fetch } });

  beforeEach(() => {
    requests.length = 0;
    resetPluginStateStoreForTests();
    resetTelegramMessageCacheForTest();
    installTelegramStateRuntimeForTest();
  });

  afterEach(() => {
    clearTelegramRuntime();
    resetTelegramMessageCacheForTest();
    resetPluginStateStoreForTests();
  });

  it("serializes direct draft destinations while keeping edits topic-free", async () => {
    const direct = createTelegramDraftStream({
      api: bot.api,
      chatId: DIRECT_CHAT_ID,
      thread: { id: DIRECT_TOPIC_ID, scope: "direct-messages" },
    });
    direct.update("direct preview");
    await direct.flush();
    direct.update("direct preview updated");
    await direct.flush();
    await direct.discard?.();

    const directSend = requests.find((request) => request.method === "sendMessage");
    const directEdit = requests.find((request) => request.method === "editMessageText");
    expect(directSend && parseJsonBody(directSend)).toMatchObject({
      direct_messages_topic_id: DIRECT_TOPIC_ID,
    });
    expect(directSend && parseJsonBody(directSend)).not.toHaveProperty("message_thread_id");
    expect(directEdit && parseJsonBody(directEdit)).not.toHaveProperty("message_thread_id");
    expect(directEdit && parseJsonBody(directEdit)).not.toHaveProperty("direct_messages_topic_id");
  });

  it("serializes a channel Direct Messages document through real multipart transport", async () => {
    await sendMessageTelegram(`${DIRECT_CHAT_ID}:direct-topic:${DIRECT_TOPIC_ID}`, "document", {
      cfg,
      token: TOKEN,
      api: bot.api,
      mediaUrl: "/tmp/direct-topic-proof.pdf",
      mediaAccess: {
        localRoots: ["/tmp"],
        readFile: async () => Buffer.from("%PDF-1.7 direct-topic-proof"),
      },
    });

    const request = requests.find((candidate) => candidate.method === "sendDocument");
    expect(request?.contentType).toMatch(/^multipart\/form-data; boundary=/i);
    expect(request && hasMultipartField(request, "direct_messages_topic_id", "77")).toBe(true);
    expect(request && hasMultipartField(request, "message_thread_id")).toBe(false);
    expect(request && hasMultipartField(request, "document")).toBe(true);
  });

  it("round-trips direct-topic conversation custody into the canonical Bot API field", async () => {
    const inbound = await buildTelegramMessageContextForTest({
      message: directMessagesMessage(),
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });
    expect(inbound?.ctxPayload.SessionKey).toContain(
      `telegram:group:${DIRECT_CHAT_ID}:direct-topic:${DIRECT_TOPIC_ID}`,
    );
    const directRef = telegramPlugin.messaging?.resolveInboundConversation?.({
      to: inbound?.ctxPayload.OriginatingTo,
      isGroup: true,
    });
    expect(directRef?.conversationId).toBe(`${DIRECT_CHAT_ID}:direct-topic:${DIRECT_TOPIC_ID}`);
    if (!directRef?.conversationId) {
      throw new Error("expected direct-topic conversation reference");
    }
    const persistedRef = structuredClone({
      conversationId: directRef.conversationId,
      parentConversationId: directRef.parentConversationId,
    });
    const target = telegramPlugin.messaging?.resolveDeliveryTarget?.(persistedRef);
    if (!target?.to) {
      throw new Error("expected persisted direct-topic delivery target");
    }
    installTelegramStateRuntimeForTest();
    await sendMessageTelegram(target.to, "roundtrip", {
      cfg,
      token: TOKEN,
      api: bot.api,
      messageThreadId: target.threadId ? Number(target.threadId) : undefined,
    });

    const request = requests.find((candidate) => candidate.method === "sendMessage");
    expect(request && parseJsonBody(request)).toMatchObject({
      direct_messages_topic_id: DIRECT_TOPIC_ID,
    });
    expect(request && parseJsonBody(request)).not.toHaveProperty("message_thread_id");
  });

  it("serializes local rich delivery through the canonical direct topic field", async () => {
    const richCfg = {
      ...cfg,
      channels: { telegram: { botToken: TOKEN, richMessages: true } },
    } satisfies OpenClawConfig;
    await sendMessageTelegram(`${DIRECT_CHAT_ID}:direct-topic:${DIRECT_TOPIC_ID}`, "**rich**", {
      cfg: richCfg,
      token: TOKEN,
      api: bot.api,
    });

    const request = requests.find((candidate) => candidate.method === "sendRichMessage");
    expect(request && parseJsonBody(request)).toMatchObject({
      direct_messages_topic_id: DIRECT_TOPIC_ID,
    });
    expect(request && parseJsonBody(request)).not.toHaveProperty("message_thread_id");
  });

  it("rejects poll and typing for channel Direct Messages without transport", async () => {
    const before = requests.length;
    await expect(
      sendPollTelegram(
        `${DIRECT_CHAT_ID}:direct-topic:${DIRECT_TOPIC_ID}`,
        { question: "Choose", options: ["A", "B"], maxSelections: 1 },
        { cfg, token: TOKEN, api: bot.api },
      ),
    ).rejects.toThrow(/polls are not supported in channel Direct Messages/i);
    await expect(
      sendTypingTelegram(`${DIRECT_CHAT_ID}:direct-topic:${DIRECT_TOPIC_ID}`, {
        cfg,
        token: TOKEN,
        api: bot.api,
      }),
    ).rejects.toThrow(/typing is not supported in channel Direct Messages/i);
    expect(requests).toHaveLength(before);
  });

  it("serializes callback replies through only the canonical direct topic field", async () => {
    const callbackMessage = directMessagesMessage({
      message_thread_id: 999,
    }) as unknown as Message;
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      threadSpec: { id: DIRECT_TOPIC_ID, scope: "direct-messages" },
    });

    await actions.replyToCallbackChat("callback reply");

    const request = requests.find((candidate) => candidate.method === "sendMessage");
    expect(request && parseJsonBody(request)).toMatchObject({
      direct_messages_topic_id: DIRECT_TOPIC_ID,
    });
    expect(request && parseJsonBody(request)).not.toHaveProperty("message_thread_id");
  });
});
