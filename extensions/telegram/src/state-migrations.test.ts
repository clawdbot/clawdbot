import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it } from "vitest";
import { resolveTelegramMessageCachePath } from "./message-cache.js";
import { detectTelegramLegacyStateMigrations } from "./state-migrations.js";

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
});
