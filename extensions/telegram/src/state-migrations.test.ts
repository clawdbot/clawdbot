import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it } from "vitest";
import { resolveTelegramBotInfoCachePath } from "./bot-info-cache.js";
import { resolveTelegramMessageCachePath } from "./message-cache.js";
import { detectTelegramLegacyStateMigrations } from "./state-migrations.js";
import {
  resolveTopicNameCacheNamespace,
  resolveTopicNameCachePath,
  resolveTopicNameCacheScope,
} from "./topic-name-cache.js";

type PersistedCacheEntry = {
  key: string;
  node: {
    sourceMessage: Message;
  };
};

function persistedCacheEntry(messageId: number, text: string): PersistedCacheEntry {
  return {
    key: `default:7:${messageId}`,
    node: {
      sourceMessage: {
        chat: { id: 7, type: "group", title: "Ops" },
        message_id: messageId,
        date: 1736380000 + messageId,
        text,
        from: { id: messageId, is_bot: false, first_name: `User ${messageId}` },
      } as Message,
    },
  };
}

describe("telegram state migrations", () => {
  it("detects legacy bot-info cache import", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-state-migration-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const persistedPath = resolveTelegramBotInfoCachePath("ops", env);
    try {
      await mkdir(path.dirname(persistedPath), { recursive: true });
      await writeFile(
        persistedPath,
        JSON.stringify({
          version: 1,
          tokenFingerprint: "token:fingerprint",
          fetchedAt: "2026-05-24T11:00:00.000Z",
          botInfo: {
            id: 123456,
            is_bot: true,
            first_name: "OpenClaw",
            username: "openclaw_bot",
          },
        }),
      );

      const cfg = {
        channels: {
          telegram: {
            accounts: {
              ops: {
                botToken: "123456:secret",
              },
            },
          },
        },
      } as OpenClawConfig;
      const plans = await detectTelegramLegacyStateMigrations({ cfg, env });
      const botInfoPlan = plans.find(
        (plan) =>
          plan.kind === "plugin-state-import" && plan.label === "Telegram startup bot info cache",
      );

      expect(botInfoPlan).toMatchObject({
        kind: "plugin-state-import",
        sourcePath: persistedPath,
        targetPath: "plugin state:telegram.bot-info-cache",
        pluginId: "telegram",
        namespace: "telegram.bot-info-cache",
        scopeKey: "",
      });
      if (!botInfoPlan || botInfoPlan.kind !== "plugin-state-import") {
        throw new Error("expected Telegram bot-info plugin-state import plan");
      }

      const entries = await botInfoPlan.readEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        key: "ops",
        value: {
          tokenFingerprint: "token:fingerprint",
          fetchedAt: "2026-05-24T11:00:00.000Z",
          botInfo: {
            id: 123456,
            username: "openclaw_bot",
          },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects legacy message-cache import for the runtime sidecar path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-state-migration-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const storePath = resolveStorePath(undefined, { env });
    const persistedPath = resolveTelegramMessageCachePath(storePath);
    try {
      await mkdir(path.dirname(persistedPath), { recursive: true });
      await writeFile(
        persistedPath,
        JSON.stringify([persistedCacheEntry(9201, "doctor imports this")]),
      );

      const cfg = {
        agents: {
          list: [{ id: "ops", default: true }],
        },
      } as OpenClawConfig;
      const plans = await detectTelegramLegacyStateMigrations({ cfg, env });
      const messageCachePlan = plans.find(
        (plan) =>
          plan.kind === "plugin-state-import" &&
          plan.label === "Telegram prompt-context message cache",
      );

      expect(messageCachePlan).toMatchObject({
        kind: "plugin-state-import",
        sourcePath: persistedPath,
        targetPath: "plugin state:telegram.message-cache",
        pluginId: "telegram",
        namespace: "telegram.message-cache",
      });
      if (!messageCachePlan || messageCachePlan.kind !== "plugin-state-import") {
        throw new Error("expected Telegram message-cache plugin-state import plan");
      }

      const entries = await messageCachePlan.readEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.key).toBe("default:7:9201");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects legacy topic-name cache import for an account-scoped runtime sidecar path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-state-migration-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const storePath = resolveStorePath(undefined, { env, agentId: "ops" });
    const persistedPath = resolveTopicNameCachePath(storePath);
    const namespace = resolveTopicNameCacheNamespace(resolveTopicNameCacheScope(storePath));
    try {
      await mkdir(path.dirname(persistedPath), { recursive: true });
      await writeFile(
        persistedPath,
        JSON.stringify({
          "7:42": {
            name: "Deployments",
            iconColor: 0x6fb9f0,
            updatedAt: 1736380000,
          },
        }),
      );

      const cfg = {
        channels: {
          telegram: {
            accounts: {
              ops: {
                botToken: "123456:secret",
              },
            },
          },
        },
      } as OpenClawConfig;
      const plans = await detectTelegramLegacyStateMigrations({ cfg, env });
      const topicNamePlan = plans.find(
        (plan) =>
          plan.kind === "plugin-state-import" && plan.label === "Telegram forum topic-name cache",
      );

      expect(topicNamePlan).toMatchObject({
        kind: "plugin-state-import",
        sourcePath: persistedPath,
        targetPath: `plugin state:${namespace}`,
        pluginId: "telegram",
        namespace,
        scopeKey: "",
      });
      if (!topicNamePlan || topicNamePlan.kind !== "plugin-state-import") {
        throw new Error("expected Telegram topic-name plugin-state import plan");
      }

      const entries = await topicNamePlan.readEntries();
      expect(entries).toStrictEqual([
        {
          key: "7:42",
          value: {
            name: "Deployments",
            iconColor: 0x6fb9f0,
            updatedAt: 1736380000,
          },
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects legacy topic-name cache import for the global sidecar path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-state-migration-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const legacyStorePath = path.join(dir, "sessions", "sessions.json");
    const persistedPath = resolveTopicNameCachePath(legacyStorePath);
    const defaultAccountStorePath = resolveStorePath(undefined, { env, agentId: "ops" });
    const namespace = resolveTopicNameCacheNamespace(
      resolveTopicNameCacheScope(defaultAccountStorePath),
    );
    try {
      await mkdir(path.dirname(persistedPath), { recursive: true });
      await writeFile(
        persistedPath,
        JSON.stringify({
          "7:43": {
            name: "Legacy Deployments",
            iconColor: 0x6fb9f1,
            updatedAt: 1736380001,
          },
        }),
      );

      const cfg = {
        channels: {
          telegram: {
            accounts: {
              ops: {
                botToken: "123456:secret",
              },
            },
          },
        },
      } as OpenClawConfig;
      const plans = await detectTelegramLegacyStateMigrations({ cfg, env });
      const topicNamePlan = plans.find(
        (plan) =>
          plan.kind === "plugin-state-import" && plan.label === "Telegram forum topic-name cache",
      );

      expect(topicNamePlan).toMatchObject({
        kind: "plugin-state-import",
        sourcePath: persistedPath,
        targetPath: `plugin state:${namespace}`,
        pluginId: "telegram",
        namespace,
        scopeKey: "",
      });
      if (!topicNamePlan || topicNamePlan.kind !== "plugin-state-import") {
        throw new Error("expected Telegram topic-name plugin-state import plan");
      }

      const entries = await topicNamePlan.readEntries();
      expect(entries).toStrictEqual([
        {
          key: "7:43",
          value: {
            name: "Legacy Deployments",
            iconColor: 0x6fb9f1,
            updatedAt: 1736380001,
          },
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
