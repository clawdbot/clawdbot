// Telegram tests cover state migrations plugin behavior.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { buildLegacyMigrationPreview } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "../doctor-contract-api.js";
import { resolveTelegramBotInfoCachePath } from "./bot-info-cache.js";
import { resolveTelegramMessageCachePath } from "./message-cache-persistence.js";
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
    threadId?: string;
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

afterEach(() => {
  resetPluginStateStoreForTests();
});

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
    const storePath = resolveStorePath(undefined, { env, agentId: "main" });
    const persistedPath = resolveTelegramMessageCachePath(storePath);
    try {
      await mkdir(path.dirname(persistedPath), { recursive: true });
      const arrayEntry = persistedCacheEntry(9201, 'doctor preserves ]{"key": text');
      arrayEntry.key = "default:7:9999";
      arrayEntry.node.sourceMessage = {
        ...arrayEntry.node.sourceMessage,
        openclaw_prompt_context_projection: {
          transcriptMessageId: "must-not-be-inferred",
          partIndex: 0,
          finalPart: true,
        },
      } as Message;
      const appendedEntry = persistedCacheEntry(9202, "doctor imports appended JSONL");
      appendedEntry.node.threadId = "42";
      const invalidKeyEntry = persistedCacheEntry(9203, "invalid key");
      invalidKeyEntry.key = "orphan";
      const invalidDateEntry = persistedCacheEntry(9204, "invalid date");
      invalidDateEntry.node.sourceMessage = {
        ...invalidDateEntry.node.sourceMessage,
        date: Number.NaN,
      } as Message;
      await writeFile(
        persistedPath,
        [
          `${JSON.stringify([arrayEntry])}${JSON.stringify(appendedEntry)}`,
          JSON.stringify(invalidKeyEntry),
          JSON.stringify(invalidDateEntry),
          '{"key":"default:7:9205","node":',
        ].join("\n"),
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
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        key: "default:7:9201",
        value: { version: 1, sourceMessage: { text: 'doctor preserves ]{"key": text' } },
      });
      expect(entries[1]).toMatchObject({
        key: "default:7:9202",
        value: {
          version: 1,
          sourceMessage: { text: "doctor imports appended JSONL" },
          threadId: "42",
        },
      });
      expect(entries[0]?.value).not.toHaveProperty(
        "sourceMessage.openclaw_prompt_context_projection",
      );
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

  it("detects remaining Telegram JSON sidecars for plugin-state import", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-state-migration-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const storePath = resolveStorePath(undefined, { env, agentId: "main" });
    const now = Date.now();
    const updateOffsetPath = path.join(dir, "telegram", "update-offset-ops.json");
    const botInfoPath = resolveTelegramBotInfoCachePath("ops", env);
    const stickerCachePath = path.join(dir, "telegram", "sticker-cache.json");
    const messageCachePath = resolveTelegramMessageCachePath(storePath);
    const sentMessagePath = `${storePath}.telegram-sent-messages.json`;
    const topicNamePath = resolveTopicNameCachePath(storePath);
    const threadBindingsPath = path.join(dir, "telegram", "thread-bindings-ops.json");
    try {
      await mkdir(path.dirname(updateOffsetPath), { recursive: true });
      await mkdir(path.dirname(sentMessagePath), { recursive: true });
      await writeFile(
        updateOffsetPath,
        JSON.stringify({
          version: 3,
          lastUpdateId: 12345,
          botId: "123456",
          tokenFingerprint: "token:fingerprint",
        }),
      );
      await writeFile(
        botInfoPath,
        JSON.stringify({
          version: 1,
          tokenFingerprint: "token:fingerprint",
          fetchedAt: "2026-05-24T11:00:00.000Z",
          botInfo: { id: 123456, is_bot: true, first_name: "OpenClaw" },
        }),
      );
      await writeFile(
        stickerCachePath,
        JSON.stringify({
          version: 1,
          stickers: {
            unique_sticker: {
              fileId: "file-1",
              fileUniqueId: "unique_sticker",
              description: "Deploy sticker",
              cachedAt: "2026-05-24T12:00:00.000Z",
            },
          },
        }),
      );
      await writeFile(messageCachePath, JSON.stringify([persistedCacheEntry(42, "hello")]));
      await writeFile(sentMessagePath, JSON.stringify({ 7: { 42: now } }));
      await writeFile(
        topicNamePath,
        JSON.stringify({ "7:42": { name: "Deployments", updatedAt: now } }),
      );
      await writeFile(
        threadBindingsPath,
        JSON.stringify({
          version: 1,
          bindings: [
            {
              accountId: "ops",
              conversationId: "-100:topic:7",
              targetKind: "subagent",
              targetSessionKey: "agent:main:subagent:child",
              boundAt: now,
              lastActivityAt: now,
            },
          ],
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

      expect(
        plans.map((plan) => ({
          kind: plan.kind,
          label: plan.label,
          sourcePath: plan.sourcePath,
          targetPath: plan.targetPath,
          namespace: plan.kind === "plugin-state-import" ? plan.namespace : null,
        })),
      ).toEqual([
        {
          kind: "plugin-state-import",
          label: "Telegram update offset",
          sourcePath: updateOffsetPath,
          targetPath: "plugin state:telegram.update-offsets",
          namespace: "telegram.update-offsets",
        },
        {
          kind: "plugin-state-import",
          label: "Telegram startup bot info cache",
          sourcePath: botInfoPath,
          targetPath: "plugin state:telegram.bot-info-cache",
          namespace: "telegram.bot-info-cache",
        },
        {
          kind: "plugin-state-import",
          label: "Telegram sticker cache",
          sourcePath: stickerCachePath,
          targetPath: "plugin state:telegram.sticker-cache",
          namespace: "telegram.sticker-cache",
        },
        {
          kind: "plugin-state-import",
          label: "Telegram prompt-context message cache",
          sourcePath: messageCachePath,
          targetPath: "plugin state:telegram.message-cache",
          namespace: "telegram.message-cache",
        },
        {
          kind: "plugin-state-import",
          label: "Telegram sent-message cache",
          sourcePath: sentMessagePath,
          targetPath: "plugin state:telegram.sent-messages",
          namespace: "telegram.sent-messages",
        },
        {
          kind: "plugin-state-import",
          label: "Telegram forum topic-name cache",
          sourcePath: topicNamePath,
          targetPath: `plugin state:${resolveTopicNameCacheNamespace(resolveTopicNameCacheScope(storePath))}`,
          namespace: resolveTopicNameCacheNamespace(resolveTopicNameCacheScope(storePath)),
        },
        {
          kind: "plugin-state-import",
          label: "Telegram thread bindings",
          sourcePath: threadBindingsPath,
          targetPath: "plugin state:telegram.thread-bindings",
          namespace: "telegram.thread-bindings",
        },
      ]);
      await expect(
        stateMigrations[0]?.detectLegacyState({
          config: cfg,
          env,
          stateDir: dir,
          oauthDir: path.join(dir, "credentials"),
          context: { openPluginStateKeyedStore: vi.fn() } as never,
        }),
      ).resolves.toEqual({ preview: plans.map(buildLegacyMigrationPreview) });

      const byLabel = new Map(plans.map((plan) => [plan.label, plan]));
      expect(byLabel.get("Telegram update offset")).toMatchObject({
        kind: "plugin-state-import",
        sourcePath: updateOffsetPath,
        namespace: "telegram.update-offsets",
      });
      expect(byLabel.get("Telegram sticker cache")).toMatchObject({
        kind: "plugin-state-import",
        sourcePath: stickerCachePath,
        namespace: "telegram.sticker-cache",
      });
      expect(byLabel.get("Telegram sent-message cache")).toMatchObject({
        kind: "plugin-state-import",
        sourcePath: sentMessagePath,
        namespace: "telegram.sent-messages",
        cleanupWhenEmpty: true,
      });
      expect(byLabel.get("Telegram thread bindings")).toMatchObject({
        kind: "plugin-state-import",
        sourcePath: threadBindingsPath,
        namespace: "telegram.thread-bindings",
      });

      for (const label of [
        "Telegram update offset",
        "Telegram sticker cache",
        "Telegram sent-message cache",
        "Telegram thread bindings",
      ]) {
        const plan = byLabel.get(label);
        if (!plan || plan.kind !== "plugin-state-import") {
          throw new Error(`expected plugin-state import plan: ${label}`);
        }
        expect(await plan.readEntries()).toHaveLength(1);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cleans up expired and boundary Telegram sent-message cache sidecars", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-state-migration-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const storePath = resolveStorePath(undefined, { env, agentId: "main" });
    const sentMessagePath = `${storePath}.telegram-sent-messages.json`;
    const expiredAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const boundaryAt = Date.now() - 24 * 60 * 60 * 1000;
    try {
      await mkdir(path.dirname(sentMessagePath), { recursive: true });
      await writeFile(sentMessagePath, JSON.stringify({ 7: { 42: expiredAt, 43: boundaryAt } }));

      const cfg = {
        channels: {
          telegram: {
            accounts: {
              ops: {
                botToken: "test",
              },
            },
          },
        },
      } as OpenClawConfig;
      const plans = await detectTelegramLegacyStateMigrations({ cfg, env });
      const expiredPlans = plans.filter(
        (plan) => plan.kind === "plugin-state-import" && plan.sourcePath === sentMessagePath,
      );

      expect(expiredPlans).toHaveLength(1);
      for (const plan of expiredPlans) {
        expect(plan).toMatchObject({ cleanupSource: "rename", cleanupWhenEmpty: true });
        if (plan.kind !== "plugin-state-import") {
          throw new Error("expected Telegram TTL cache import plan");
        }
        expect(await plan.readEntries()).toStrictEqual([]);
      }
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Telegram account sidecars even after the account was removed from config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-state-migration-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const updateOffsetPath = path.join(dir, "telegram", "update-offset-oldbot.json");
    const threadBindingsPath = path.join(dir, "telegram", "thread-bindings-oldbot.json");
    const now = Date.now();
    try {
      await mkdir(path.dirname(updateOffsetPath), { recursive: true });
      await writeFile(
        updateOffsetPath,
        JSON.stringify({
          version: 3,
          lastUpdateId: 12345,
          botId: "123456",
          tokenFingerprint: "token:fingerprint",
        }),
      );
      await writeFile(
        threadBindingsPath,
        JSON.stringify({
          version: 1,
          bindings: [
            {
              accountId: "oldbot",
              conversationId: "-100:topic:7",
              targetKind: "subagent",
              targetSessionKey: "agent:main:subagent:child",
              boundAt: now,
              lastActivityAt: now,
            },
          ],
        }),
      );

      const plans = await detectTelegramLegacyStateMigrations({ cfg: {}, env });
      const updateOffsetPlan = plans.find((plan) => plan.sourcePath === updateOffsetPath);
      const threadBindingsPlan = plans.find((plan) => plan.sourcePath === threadBindingsPath);

      expect(updateOffsetPlan).toMatchObject({
        kind: "plugin-state-import",
        label: "Telegram update offset",
        namespace: "telegram.update-offsets",
      });
      expect(threadBindingsPlan).toMatchObject({
        kind: "plugin-state-import",
        label: "Telegram thread bindings",
        namespace: "telegram.thread-bindings",
      });
      if (!updateOffsetPlan || updateOffsetPlan.kind !== "plugin-state-import") {
        throw new Error("expected orphaned update offset import plan");
      }
      if (!threadBindingsPlan || threadBindingsPlan.kind !== "plugin-state-import") {
        throw new Error("expected orphaned thread bindings import plan");
      }
      expect(await updateOffsetPlan.readEntries()).toHaveLength(1);
      expect(await threadBindingsPlan.readEntries()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("imports legacy sent-message sidecars into the current runtime scope", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-state-migration-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const storePath = resolveStorePath(undefined, { env, agentId: "main" });
    const legacyStorePath = path.join(dir, "sessions", "sessions.json");
    const currentSentPath = `${storePath}.telegram-sent-messages.json`;
    const legacySentPath = `${legacyStorePath}.telegram-sent-messages.json`;
    const now = Date.now();
    try {
      await mkdir(path.dirname(currentSentPath), { recursive: true });
      await mkdir(path.dirname(legacySentPath), { recursive: true });
      const sentPayload = JSON.stringify({ 7: { 42: now } });
      await writeFile(currentSentPath, sentPayload);
      await writeFile(legacySentPath, sentPayload);

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
      const importPlans = plans.filter((plan) => plan.kind === "plugin-state-import");
      const currentSentPlan = importPlans.find(
        (plan) =>
          plan.label === "Telegram sent-message cache" && plan.sourcePath === currentSentPath,
      );
      const legacySentPlan = importPlans.find(
        (plan) =>
          plan.label === "Telegram sent-message cache" && plan.sourcePath === legacySentPath,
      );
      if (!currentSentPlan || !legacySentPlan) {
        throw new Error("expected current and legacy session-store import plans");
      }

      const stripTtl = (entries: Awaited<ReturnType<typeof currentSentPlan.readEntries>>) =>
        entries.map(({ ttlMs: _ttlMs, ...entry }) => entry);
      const currentSentEntries = stripTtl(await currentSentPlan.readEntries());
      expect(stripTtl(await legacySentPlan.readEntries())).toStrictEqual(currentSentEntries);
      expect(currentSentEntries[0]?.value).toMatchObject({
        scopeKey: createHash("sha256").update(storePath, "utf8").digest("hex").slice(0, 24),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
