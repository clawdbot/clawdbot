// Two configured Telegram accounts can each hold their own Business Connect
// link to a different personal/business account. The chat route store must
// key by (accountId, chatId), not chatId alone — otherwise two accounts
// connected to the same counterpart chat id would silently overwrite each
// other's route, risking a reply or read-receipt going out through the wrong
// connected account.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearBusinessChatUnread,
  recordBusinessChatMessage,
  resolveBusinessChatRoute,
} from "./business-connection-store.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const SHARED_CHAT_ID = "700700700";

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

async function withBusinessTestEnv(fn: () => Promise<void>): Promise<void> {
  await withStateDirEnv("openclaw-tg-business-store-", async () => {
    try {
      await fn();
    } finally {
      resetPluginStateStoreForTests();
    }
  });
}

describe("business chat route store: per-account scoping", () => {
  beforeEach(() => {
    installBusinessStoreRuntime();
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
  });

  it("keeps routes for two accounts connected to the same chat id independent", async () =>
    withBusinessTestEnv(async () => {
      await recordBusinessChatMessage({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
        businessConnectionId: "conn-a",
        messageId: 1,
      });
      await recordBusinessChatMessage({
        accountId: "account-b",
        chatId: SHARED_CHAT_ID,
        businessConnectionId: "conn-b",
        messageId: 2,
      });

      const routeA = await resolveBusinessChatRoute({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
      });
      const routeB = await resolveBusinessChatRoute({
        accountId: "account-b",
        chatId: SHARED_CHAT_ID,
      });

      expect(routeA?.businessConnectionId).toBe("conn-a");
      expect(routeA?.latestUnreadMessageId).toBe(1);
      expect(routeB?.businessConnectionId).toBe("conn-b");
      expect(routeB?.latestUnreadMessageId).toBe(2);
    }));

  it("does not let a later write from one account clobber another account's route for the same chat", async () =>
    withBusinessTestEnv(async () => {
      await recordBusinessChatMessage({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
        businessConnectionId: "conn-a",
        messageId: 1,
      });
      await recordBusinessChatMessage({
        accountId: "account-b",
        chatId: SHARED_CHAT_ID,
        businessConnectionId: "conn-b",
        messageId: 99,
      });

      const routeA = await resolveBusinessChatRoute({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
      });
      expect(routeA?.businessConnectionId).toBe("conn-a");
      expect(routeA?.latestUnreadMessageId).toBe(1);
    }));

  it("clearing the unread marker for one account's route does not affect another account's route", async () =>
    withBusinessTestEnv(async () => {
      await recordBusinessChatMessage({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
        businessConnectionId: "conn-a",
        messageId: 1,
      });
      await recordBusinessChatMessage({
        accountId: "account-b",
        chatId: SHARED_CHAT_ID,
        businessConnectionId: "conn-b",
        messageId: 2,
      });

      await clearBusinessChatUnread({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
        expectedMessageId: 1,
      });

      const routeA = await resolveBusinessChatRoute({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
      });
      const routeB = await resolveBusinessChatRoute({
        accountId: "account-b",
        chatId: SHARED_CHAT_ID,
      });

      expect(routeA?.latestUnreadMessageId).toBeUndefined();
      expect(routeA?.businessConnectionId).toBe("conn-a");
      expect(routeB?.latestUnreadMessageId).toBe(2);
      expect(routeB?.businessConnectionId).toBe("conn-b");
    }));

  it("does not drop a newer unread message's read-receipt when an older read-receipt clears late", async () =>
    withBusinessTestEnv(async () => {
      // Message 1 arrives; a reply/read-receipt turn for it starts.
      await recordBusinessChatMessage({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
        businessConnectionId: "conn-a",
        messageId: 1,
      });

      // Message 2 arrives before message 1's read-receipt call resolves,
      // bumping the route's marker forward.
      await recordBusinessChatMessage({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
        businessConnectionId: "conn-a",
        messageId: 2,
      });

      // Message 1's (now stale) read-receipt clear finally lands. It must
      // not clear message 2's still-pending marker.
      await clearBusinessChatUnread({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
        expectedMessageId: 1,
      });
      const afterStaleClear = await resolveBusinessChatRoute({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
      });
      expect(afterStaleClear?.latestUnreadMessageId).toBe(2);

      // Message 2's own read-receipt then clears it normally.
      await clearBusinessChatUnread({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
        expectedMessageId: 2,
      });
      const afterCurrentClear = await resolveBusinessChatRoute({
        accountId: "account-a",
        chatId: SHARED_CHAT_ID,
      });
      expect(afterCurrentClear?.latestUnreadMessageId).toBeUndefined();
    }));

  it("falls back to a shared default-account bucket when accountId is omitted, matching prior single-account behavior", async () =>
    withBusinessTestEnv(async () => {
      await recordBusinessChatMessage({
        chatId: SHARED_CHAT_ID,
        businessConnectionId: "conn-default",
        messageId: 7,
      });

      const route = await resolveBusinessChatRoute({ chatId: SHARED_CHAT_ID });
      expect(route?.businessConnectionId).toBe("conn-default");
    }));
});
