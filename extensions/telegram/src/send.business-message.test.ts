// Telegram tests cover outbound Business Connect wiring: business_connection_id
// on sendMessage, and readBusinessMessage fired synchronously with the send.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";

installTelegramSendTestHooks();

const { botApi } = getTelegramSendTestMocks();
const { sendMessageTelegram } = await importTelegramSendModule();
const { upsertBusinessConnection, recordBusinessChatMessage } =
  await import("./business-connection-store.js");

const CONNECTION_ID = "biz-conn-1";
const OWNER_USER_ID = 555000111;
const CHAT_ID = 700700700;
const TELEGRAM_TEST_CFG = {};

let stores: Map<string, PluginStateKeyedStore<unknown>>;

function installBusinessStoreRuntime() {
  stores = new Map();
  setTelegramRuntime({
    state: {
      openKeyedStore: ((opts: { namespace: string; maxEntries: number }) => {
        let store = stores.get(opts.namespace);
        if (!store) {
          store = createPluginStateKeyedStoreForTests(
            "telegram",
            opts,
          ) as PluginStateKeyedStore<unknown>;
          stores.set(opts.namespace, store);
        }
        return store;
      }) as TelegramRuntime["state"]["openKeyedStore"],
    },
    channel: {},
  } as TelegramRuntime);
}

async function seedEnabledConnectionAndUnreadMessage(messageId: number) {
  await upsertBusinessConnection({
    id: CONNECTION_ID,
    user: { id: OWNER_USER_ID, is_bot: false, first_name: "Vitalik" },
    user_chat_id: OWNER_USER_ID,
    date: 1736380800,
    is_enabled: true,
    rights: { can_reply: true, can_read_messages: true },
  } as never);
  await recordBusinessChatMessage({
    chatId: CHAT_ID,
    businessConnectionId: CONNECTION_ID,
    messageId,
  });
}

async function withBusinessTestEnv(fn: () => Promise<void>): Promise<void> {
  await withStateDirEnv("openclaw-tg-business-send-", async () => {
    try {
      await fn();
    } finally {
      // Close the SQLite handle before withStateDirEnv removes the temp
      // directory — Windows refuses to unlink a file still memory-mapped by
      // an open handle.
      resetPluginStateStoreForTests();
    }
  });
}

describe("sendMessageTelegram business_connection_id + read receipt", () => {
  beforeEach(() => {
    installBusinessStoreRuntime();
    botApi.sendMessage.mockResolvedValue({ message_id: 77, chat: { id: CHAT_ID } });
    botApi.readBusinessMessage.mockResolvedValue(true);
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
  });

  it("attaches business_connection_id to sendMessage and marks read synchronously", async () =>
    withBusinessTestEnv(async () => {
      await seedEnabledConnectionAndUnreadMessage(4);

      await sendMessageTelegram(String(CHAT_ID), "here is my reply", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        businessConnectionId: CONNECTION_ID,
        markReadMessageId: 4,
      });

      expect(botApi.readBusinessMessage).toHaveBeenCalledWith(CONNECTION_ID, CHAT_ID, 4);
      expect(botApi.sendMessage).toHaveBeenCalledWith(
        String(CHAT_ID),
        "here is my reply",
        expect.objectContaining({ business_connection_id: CONNECTION_ID }),
      );
    }));

  it("does not attach business_connection_id for a plain (non-business) send", async () =>
    withBusinessTestEnv(async () => {
      await sendMessageTelegram(String(CHAT_ID), "plain reply", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
      });

      expect(botApi.readBusinessMessage).not.toHaveBeenCalled();
      const params = botApi.sendMessage.mock.calls[0]?.[2];
      expect(params as Record<string, unknown> | undefined).not.toHaveProperty(
        "business_connection_id",
      );
    }));

  it("skips (does not fail the send on) a stale unread marker once the connection loses can_read_messages", async () =>
    withBusinessTestEnv(async () => {
      await upsertBusinessConnection({
        id: CONNECTION_ID,
        user: { id: OWNER_USER_ID, is_bot: false, first_name: "Vitalik" },
        user_chat_id: OWNER_USER_ID,
        date: 1736380800,
        is_enabled: true,
        rights: { can_reply: true, can_read_messages: false },
      } as never);

      await sendMessageTelegram(String(CHAT_ID), "hello", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        businessConnectionId: CONNECTION_ID,
        markReadMessageId: 4,
      });

      // Read-receipt failures must never block the reply from actually sending.
      expect(botApi.readBusinessMessage).not.toHaveBeenCalled();
      expect(botApi.sendMessage).toHaveBeenCalledWith(
        String(CHAT_ID),
        "hello",
        expect.objectContaining({ business_connection_id: CONNECTION_ID }),
      );
    }));
});
