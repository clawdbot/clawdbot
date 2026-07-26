// Telegram tests cover the outbound adapter's Business Connect routing: it must
// attach businessConnectionId/markReadMessageId for chats with an active
// business route, and fail fast (not silently fall back to a plain bot DM)
// once the connection is disconnected.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const sendMessageTelegramMock = vi.fn();

vi.mock("./send.js", () => ({
  pinMessageTelegram: vi.fn(),
  reactMessageTelegram: vi.fn(),
  sendPollTelegram: vi.fn(),
  sendLocationTelegram: vi.fn(),
  sendMessageTelegram: (...args: unknown[]) => sendMessageTelegramMock(...args),
}));

const { telegramOutbound } = await import("./outbound-adapter.js");
const { upsertBusinessConnection, recordBusinessChatMessage } =
  await import("./business-connection-store.js");

const CONNECTION_ID = "biz-conn-1";
const OWNER_USER_ID = 555000111;
const CHAT_ID = "700700700";

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

async function seedConnection(isEnabled: boolean) {
  await upsertBusinessConnection({
    id: CONNECTION_ID,
    user: { id: OWNER_USER_ID, is_bot: false, first_name: "Vitalik" },
    user_chat_id: OWNER_USER_ID,
    date: 1736380800,
    is_enabled: isEnabled,
    rights: { can_reply: true, can_read_messages: true },
  } as never);
  await recordBusinessChatMessage({
    chatId: CHAT_ID,
    businessConnectionId: CONNECTION_ID,
    messageId: 4,
  });
}

async function withBusinessTestEnv(fn: () => Promise<void>): Promise<void> {
  await withStateDirEnv("openclaw-tg-outbound-business-", async () => {
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

describe("telegramOutbound business connection routing", () => {
  beforeEach(() => {
    sendMessageTelegramMock.mockReset();
    installBusinessStoreRuntime();
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
  });

  it("attaches businessConnectionId and markReadMessageId for a chat with an active business route", async () =>
    withBusinessTestEnv(async () => {
      await seedConnection(true);
      sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-1", chatId: CHAT_ID });

      await telegramOutbound.sendText!({
        cfg: {} as never,
        to: CHAT_ID,
        text: "here is my reply",
        deps: { sendTelegram: sendMessageTelegramMock },
      });

      expect(sendMessageTelegramMock).toHaveBeenCalledWith(
        CHAT_ID,
        "here is my reply",
        expect.objectContaining({
          businessConnectionId: CONNECTION_ID,
          markReadMessageId: 4,
        }),
      );
    }));

  it("does not attach a business route for a chat with no recorded business message", async () =>
    withBusinessTestEnv(async () => {
      sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-1", chatId: "999" });

      await telegramOutbound.sendText!({
        cfg: {} as never,
        to: "999",
        text: "plain reply",
        deps: { sendTelegram: sendMessageTelegramMock },
      });

      const [, , options] = sendMessageTelegramMock.mock.calls[0] ?? [];
      expect(options as Record<string, unknown> | undefined).not.toHaveProperty(
        "businessConnectionId",
      );
    }));

  it("rejects with a clear error instead of silently falling back once the connection is disconnected", async () =>
    withBusinessTestEnv(async () => {
      await seedConnection(false);

      await expect(
        telegramOutbound.sendText!({
          cfg: {} as never,
          to: CHAT_ID,
          text: "hello",
          deps: { sendTelegram: sendMessageTelegramMock },
        }),
      ).rejects.toThrow(/disconnected/);
      expect(sendMessageTelegramMock).not.toHaveBeenCalled();
    }));
});
