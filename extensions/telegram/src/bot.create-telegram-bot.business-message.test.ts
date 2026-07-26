// Telegram tests cover Business Connect (business_message) inbound routing.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const { getLoadConfigMock, getOnHandler, replySpy, getBusinessConnectionSpy } = harness;
const { createTelegramBotCore: createTelegramBotBase } = await import("./bot-core.js");

let createTelegramBot: (
  opts: import("./bot.types.js").TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();

const OWNER_USER_ID = 555000111;
const CUSTOMER_USER_ID = 42424242;
const CONNECTION_ID = "biz-conn-1";
const CHAT_ID = 700700700;

function setOpenDmConfig() {
  loadConfig.mockReturnValue({
    channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    session: { dmScope: "per-channel-peer" },
  });
}

/**
 * Minimal in-memory PluginStateKeyedStore for tests exercising the full
 * inbound dispatch pipeline. That pipeline also opens the unrelated
 * per-agent session/auth-profile sqlite (agents/<id>/agent/openclaw-agent.sqlite),
 * so a real OPENCLAW_STATE_DIR-backed store here just adds an unrelated
 * Windows file-lock hazard on cleanup with no coverage benefit — the
 * business-connection-store's real SQLite persistence is already covered by
 * send.business-message.test.ts and outbound-adapter.business-connection.test.ts.
 */
function createInMemoryKeyedStore<T>(): PluginStateKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async registerIfAbsent(key, value) {
      if (entries.has(key)) {
        return false;
      }
      entries.set(key, value);
      return true;
    },
    async update(key, updateValue) {
      const next = updateValue(entries.get(key));
      if (next === undefined) {
        entries.delete(key);
      } else {
        entries.set(key, next);
      }
      return true;
    },
    async deleteIf(key, predicate) {
      const current = entries.get(key);
      if (current !== undefined && predicate(current)) {
        entries.delete(key);
        return true;
      }
      return false;
    },
    async lookup(key) {
      return entries.get(key);
    },
    async consume(key) {
      const value = entries.get(key);
      entries.delete(key);
      return value;
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries.entries()].map(([key, value]) => ({ key, value, createdAt: Date.now() }));
    },
    async clear() {
      entries.clear();
    },
  };
}

function businessConnectionUpdate(overrides?: { isEnabled?: boolean }) {
  return {
    businessConnection: {
      id: CONNECTION_ID,
      user: { id: OWNER_USER_ID, is_bot: false, first_name: "Vitalik" },
      user_chat_id: OWNER_USER_ID,
      date: 1736380800,
      is_enabled: overrides?.isEnabled ?? true,
      rights: { can_reply: true, can_read_messages: true },
    },
    me: { id: 999, username: "openclaw_bot" },
    getFile: async () => ({}),
  };
}

function businessMessageContext(params: { fromId: number; messageId: number; text: string }) {
  return {
    businessMessage: {
      business_connection_id: CONNECTION_ID,
      chat: { id: CHAT_ID, type: "private" as const },
      message_id: params.messageId,
      date: 1736380800,
      text: params.text,
      from: { id: params.fromId, is_bot: false, first_name: "u" },
    },
    me: { id: 999, username: "openclaw_bot" },
    getFile: async () => ({}),
  };
}

function plainDmContext(params: { fromId: number; messageId: number; text: string }) {
  return {
    message: {
      chat: { id: params.fromId, type: "private" as const },
      message_id: params.messageId,
      date: 1736380800,
      text: params.text,
      from: { id: params.fromId, is_bot: false, first_name: "u" },
    },
    me: { id: 999, username: "openclaw_bot" },
    getFile: async () => ({}),
  };
}

describe("createTelegramBot business_message", () => {
  let stores: Map<string, PluginStateKeyedStore<unknown>>;

  function installBusinessStoreRuntime() {
    stores = new Map();
    setTelegramRuntime({
      state: {
        openKeyedStore: ((opts: { namespace: string }) => {
          let store = stores.get(opts.namespace);
          if (!store) {
            store = createInMemoryKeyedStore<unknown>();
            stores.set(opts.namespace, store);
          }
          return store;
        }) as TelegramRuntime["state"]["openKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
  }

  beforeAll(() => {
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: harness.telegramBotDepsForTest,
      });
  });

  beforeEach(() => {
    setOpenDmConfig();
    replySpy.mockClear();
    getBusinessConnectionSpy.mockReset();
    getBusinessConnectionSpy.mockRejectedValue(new Error("no live connection push in this test"));
    installBusinessStoreRuntime();
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
  });

  it("routes an inbound business_message from a customer to the agent run", async () => {
    createTelegramBot({ token: "tok" });
    const connectionHandler = getOnHandler("business_connection");
    const messageHandler = getOnHandler("business_message");

    await connectionHandler(businessConnectionUpdate());
    await messageHandler(
      businessMessageContext({ fromId: CUSTOMER_USER_ID, messageId: 1, text: "hi there" }),
    );

    await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
    const [ctx] = replySpy.mock.calls[0] as [{ ChatId?: unknown }];
    expect(String(ctx.ChatId)).toBe(String(CHAT_ID));
  });

  it("does not dispatch an agent run for the connection owner's own echoed message", async () => {
    createTelegramBot({ token: "tok" });
    const connectionHandler = getOnHandler("business_connection");
    const messageHandler = getOnHandler("business_message");

    await connectionHandler(businessConnectionUpdate());
    await messageHandler(
      businessMessageContext({ fromId: OWNER_USER_ID, messageId: 2, text: "own reply from phone" }),
    );

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("hydrates an unknown connection via getBusinessConnection on cache miss (post-restart)", async () => {
    getBusinessConnectionSpy.mockReset();
    getBusinessConnectionSpy.mockResolvedValue({
      id: CONNECTION_ID,
      user: { id: OWNER_USER_ID, is_bot: false, first_name: "Vitalik" },
      user_chat_id: OWNER_USER_ID,
      date: 1736380800,
      is_enabled: true,
      rights: { can_reply: true, can_read_messages: true },
    });

    createTelegramBot({ token: "tok" });
    const messageHandler = getOnHandler("business_message");

    // No business_connection push received yet in this process — simulates a
    // fresh Gateway restart after the live push was already acked.
    await messageHandler(
      businessMessageContext({ fromId: CUSTOMER_USER_ID, messageId: 3, text: "after restart" }),
    );

    expect(getBusinessConnectionSpy).toHaveBeenCalledWith(CONNECTION_ID);
    await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
  });

  it("isolates a business chat session from a plain DM session for the same sender", async () => {
    createTelegramBot({ token: "tok" });
    const connectionHandler = getOnHandler("business_connection");
    const businessHandler = getOnHandler("business_message");
    const messageHandler = getOnHandler("message");

    await connectionHandler(businessConnectionUpdate());
    await businessHandler(
      businessMessageContext({ fromId: CUSTOMER_USER_ID, messageId: 5, text: "via business chat" }),
    );
    await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
    const businessSessionKey = (replySpy.mock.calls[0]?.[0] as { SessionKey?: unknown }).SessionKey;

    replySpy.mockClear();
    await messageHandler(
      plainDmContext({ fromId: CUSTOMER_USER_ID, messageId: 6, text: "via plain dm" }),
    );
    await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
    const plainDmSessionKey = (replySpy.mock.calls[0]?.[0] as { SessionKey?: unknown }).SessionKey;

    expect(businessSessionKey).toBeDefined();
    expect(plainDmSessionKey).toBeDefined();
    expect(businessSessionKey).not.toBe(plainDmSessionKey);
  });
});
