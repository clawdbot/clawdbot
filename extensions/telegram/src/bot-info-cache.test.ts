import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteCachedTelegramBotInfo,
  readCachedTelegramBotInfo,
  resolveTelegramBotInfoCachePath,
  TELEGRAM_BOT_INFO_CACHE_MAX_AGE_MS,
  writeCachedTelegramBotInfo,
} from "./bot-info-cache.js";
import type { TelegramBotInfo } from "./bot-info.js";

const tempRoots: string[] = [];

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

async function useTempStateDir(): Promise<NodeJS.ProcessEnv> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-bot-info-"));
  tempRoots.push(stateDir);
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Telegram bot info cache", () => {
  it("reads botInfo for the same account and bot token", async () => {
    const env = await useTempStateDir();

    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:secret",
      botInfo,
      env,
    });

    await expect(
      readCachedTelegramBotInfo({ accountId: "ops", botToken: "123456:secret", env }),
    ).resolves.toMatchObject({ botInfo });
  });

  it("ignores botInfo written for a different token fingerprint", async () => {
    const env = await useTempStateDir();

    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:old-secret",
      botInfo,
      env,
    });

    await expect(
      readCachedTelegramBotInfo({ accountId: "ops", botToken: "123456:new-secret", env }),
    ).resolves.toBeNull();
  });

  it("treats stale botInfo as a cache miss", async () => {
    const env = await useTempStateDir();

    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:secret",
      botInfo,
      env,
    });

    await expect(
      readCachedTelegramBotInfo({
        accountId: "ops",
        botToken: "123456:secret",
        env,
        now: new Date(Date.now() + TELEGRAM_BOT_INFO_CACHE_MAX_AGE_MS + 1),
      }),
    ).resolves.toBeNull();
  });

  it("deletes cached botInfo for an account", async () => {
    const env = await useTempStateDir();

    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:secret",
      botInfo,
      env,
    });
    await deleteCachedTelegramBotInfo({ accountId: "ops", env });

    await expect(
      readCachedTelegramBotInfo({ accountId: "ops", botToken: "123456:secret", env }),
    ).resolves.toBeNull();
  });

  it("treats malformed persisted botInfo as a cache miss", async () => {
    const env = await useTempStateDir();
    const filePath = resolveTelegramBotInfoCachePath("ops", env);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        tokenFingerprint: "not-the-token",
        fetchedAt: new Date().toISOString(),
        botInfo: { id: 123456, is_bot: true },
      }),
      "utf8",
    );

    await expect(
      readCachedTelegramBotInfo({ accountId: "ops", botToken: "123456:secret", env }),
    ).resolves.toBeNull();
  });
});
