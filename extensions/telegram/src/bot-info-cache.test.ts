import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteCachedTelegramBotInfo,
  readCachedTelegramBotInfo,
  setTelegramBotInfoCacheStoreForTest,
  TELEGRAM_BOT_INFO_CACHE_MAX_AGE_MS,
  writeCachedTelegramBotInfo,
} from "./bot-info-cache.js";
import type { TelegramBotInfo } from "./bot-info.js";

const botInfo: TelegramBotInfo = {
  id: 123456,
  is_bot: true,
  first_name: "OpenClaw",
  username: "openclaw_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  can_manage_bots: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

type BotInfoCacheValue = {
  tokenFingerprint: string;
  fetchedAt: string;
  botInfo: TelegramBotInfo;
};

function useMemoryStore() {
  const entries = new Map<string, BotInfoCacheValue>();
  setTelegramBotInfoCacheStoreForTest({
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
  });
  return entries;
}

afterEach(() => {
  vi.unstubAllEnvs();
  setTelegramBotInfoCacheStoreForTest(undefined);
});

describe("Telegram bot info cache", () => {
  it("reads botInfo for the same account and bot token", async () => {
    useMemoryStore();

    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:secret",
      botInfo,
    });

    await expect(
      readCachedTelegramBotInfo({ accountId: "ops", botToken: "123456:secret" }),
    ).resolves.toMatchObject({ botInfo });
  });

  it("ignores botInfo written for a different token fingerprint", async () => {
    useMemoryStore();

    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:old-secret",
      botInfo,
    });

    await expect(
      readCachedTelegramBotInfo({ accountId: "ops", botToken: "123456:new-secret" }),
    ).resolves.toBeNull();
  });

  it("treats stale botInfo as a cache miss", async () => {
    useMemoryStore();

    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:secret",
      botInfo,
    });

    await expect(
      readCachedTelegramBotInfo({
        accountId: "ops",
        botToken: "123456:secret",
        now: new Date(Date.now() + TELEGRAM_BOT_INFO_CACHE_MAX_AGE_MS + 1),
      }),
    ).resolves.toBeNull();
  });

  it("deletes cached botInfo for an account", async () => {
    useMemoryStore();

    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:secret",
      botInfo,
    });
    await deleteCachedTelegramBotInfo({ accountId: "ops" });

    await expect(
      readCachedTelegramBotInfo({ accountId: "ops", botToken: "123456:secret" }),
    ).resolves.toBeNull();
  });

  it("uses normalized account ids as store keys", async () => {
    const entries = useMemoryStore();

    await writeCachedTelegramBotInfo({
      accountId: "ops team",
      botToken: "123456:secret",
      botInfo,
    });

    expect(entries.has("ops_team")).toBe(true);
  });
});
