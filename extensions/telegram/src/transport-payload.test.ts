import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTelegramCallbackMessageActions } from "./bot-handlers.callback-actions.runtime.js";
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
  const liveSockets = new Set<Socket>();
  const requests: CapturedRequest[] = [];
  let server: Server;
  let bot: Bot;
  let nextMessageId = 100;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        const method = request.url?.split("/").at(-1) ?? "unknown";
        const captured = {
          body,
          contentType: request.headers["content-type"] ?? "",
          method,
        };
        requests.push(captured);

        let result: true | Record<string, unknown> = true;
        if (method.startsWith("send")) {
          const raw = body.toString("utf8");
          const payload = captured.contentType.startsWith("application/json")
            ? parseJsonBody(captured)
            : undefined;
          const directTopic =
            payload?.direct_messages_topic_id ??
            (hasMultipartField(captured, "direct_messages_topic_id", String(DIRECT_TOPIC_ID))
              ? DIRECT_TOPIC_ID
              : undefined);
          const messageThread = payload?.message_thread_id;
          result = {
            message_id: nextMessageId++,
            date: 1_700_000_000,
            chat:
              directTopic !== undefined
                ? { id: DIRECT_CHAT_ID, type: "supergroup", is_direct_messages: true }
                : {
                    id: raw.includes('"chat_id":1234') ? 1234 : DIRECT_CHAT_ID,
                    type: "supergroup",
                  },
            ...(directTopic !== undefined
              ? {
                  direct_messages_topic: {
                    topic_id: Number(directTopic),
                    user: { id: 700, is_bot: false, first_name: "Subscriber" },
                  },
                }
              : typeof messageThread === "number"
                ? { message_thread_id: messageThread }
                : {}),
            text: "accepted",
          };
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, result }));
      });
    });
    server.on("connection", (socket) => {
      liveSockets.add(socket);
      socket.once("close", () => liveSockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    bot = new Bot(TOKEN, { client: { apiRoot } });
  });

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

  afterAll(async () => {
    for (const socket of liveSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
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
    const callbackMessage = {
      message_id: 41,
      date: 1_700_000_000,
      chat: {
        id: DIRECT_CHAT_ID,
        type: "supergroup",
        title: "Channel Direct Messages",
        is_direct_messages: true,
      },
      message_thread_id: 999,
      direct_messages_topic: {
        topic_id: DIRECT_TOPIC_ID,
        user: { id: 700, is_bot: false, first_name: "Subscriber" },
      },
      text: "button",
    } as Message;
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isGroup: true,
      isForum: false,
    });

    await actions.replyToCallbackChat("callback reply");

    const request = requests.find((candidate) => candidate.method === "sendMessage");
    expect(request && parseJsonBody(request)).toMatchObject({
      direct_messages_topic_id: DIRECT_TOPIC_ID,
    });
    expect(request && parseJsonBody(request)).not.toHaveProperty("message_thread_id");
  });
});
