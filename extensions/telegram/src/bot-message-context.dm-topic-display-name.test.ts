// Telegram tests cover direct-topic session-label synchronization.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getSessionEntry,
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { resetTelegramTopicNameCacheForTest } from "./runtime.test-support.js";

const chatId = 1234;
const threadId = 42;
const sessionKey = `agent:main:main:thread:${chatId}:${threadId}`;

let tempDir: string | undefined;

async function createStore() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-dm-topic-display-name-"));
  return path.join(tempDir, "sessions.json");
}

function createConfig(storePath: string) {
  return {
    agents: { defaults: { model: "openai/gpt-5.4", workspace: "/tmp/openclaw" } },
    channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    messages: { groupChat: { mentionPatterns: [] } },
    session: { store: storePath },
  };
}

function directTopicMessage(params: {
  messageId: number;
  createdName?: string;
  editedName?: string;
  iconCustomEmojiId?: string;
  text?: string;
}) {
  return {
    message_id: params.messageId,
    chat: { id: chatId, type: "private" },
    date: 1_700_000_000 + params.messageId,
    from: { id: chatId, first_name: "Alice" },
    is_topic_message: true,
    message_thread_id: threadId,
    text: params.text,
    ...(params.createdName !== undefined
      ? { forum_topic_created: { name: params.createdName, icon_color: 0x6fb9f0 } }
      : {}),
    ...(params.editedName !== undefined || params.iconCustomEmojiId !== undefined
      ? {
          forum_topic_edited: {
            ...(params.editedName !== undefined ? { name: params.editedName } : {}),
            ...(params.iconCustomEmojiId !== undefined
              ? { icon_custom_emoji_id: params.iconCustomEmojiId }
              : {}),
          },
        }
      : {}),
  };
}

async function buildDirectTopicContext(params: {
  cfg: ReturnType<typeof createConfig>;
  message: ReturnType<typeof directTopicMessage>;
}) {
  return await buildTelegramMessageContextForTest({
    cfg: params.cfg,
    me: { has_topics_enabled: true },
    message: params.message,
    sessionRuntime: null,
  });
}

afterEach(async () => {
  resetTelegramTopicNameCacheForTest();
  if (tempDir) {
    await fs.rm(tempDir, { force: true, recursive: true });
    tempDir = undefined;
  }
});

describe("buildTelegramMessageContext direct topic labels", () => {
  it("updates an existing session immediately for every topic rename", async () => {
    const storePath = await createStore();
    const cfg = createConfig(storePath);
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "existing-session",
        updatedAt: 1_700_000_000_000,
        label: "Manual Control UI name",
        delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
      },
    });

    await expect(
      buildDirectTopicContext({
        cfg,
        message: directTopicMessage({ messageId: 1, editedName: "First rename" }),
      }),
    ).resolves.toBeNull();
    expect(getSessionEntry({ storePath, sessionKey })).toMatchObject({
      label: "First rename",
      updatedAt: 1_700_000_000_000,
    });

    await expect(
      buildDirectTopicContext({
        cfg,
        message: directTopicMessage({ messageId: 2, editedName: "Second rename" }),
      }),
    ).resolves.toBeNull();
    expect(getSessionEntry({ storePath, sessionKey })).toMatchObject({
      label: "Second rename",
      updatedAt: 1_700_000_000_000,
    });
  });

  it("does not create a session for a topic service update", async () => {
    const storePath = await createStore();
    const cfg = createConfig(storePath);

    await expect(
      buildDirectTopicContext({
        cfg,
        message: directTopicMessage({ messageId: 1, createdName: "Fresh topic" }),
      }),
    ).resolves.toBeNull();

    expect(getSessionEntry({ storePath, sessionKey })).toBeUndefined();
  });

  it("keeps the current session label for icon-only edits", async () => {
    const storePath = await createStore();
    const cfg = createConfig(storePath);
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "existing-session",
        updatedAt: 1_700_000_000_000,
        label: "Existing topic",
      },
    });

    await expect(
      buildDirectTopicContext({
        cfg,
        message: directTopicMessage({ messageId: 1, iconCustomEmojiId: "emoji-1" }),
      }),
    ).resolves.toBeNull();

    expect(getSessionEntry({ storePath, sessionKey })?.label).toBe("Existing topic");
  });

  it("carries the cached direct-topic name into the first regular turn", async () => {
    const storePath = await createStore();
    const cfg = createConfig(storePath);

    await expect(
      buildDirectTopicContext({
        cfg,
        message: directTopicMessage({ messageId: 1, createdName: "Fresh topic" }),
      }),
    ).resolves.toBeNull();

    const context = await buildDirectTopicContext({
      cfg,
      message: directTopicMessage({ messageId: 2, text: "hello" }),
    });

    expect(context?.ctxPayload.SessionKey).toBe(sessionKey);
    expect(context?.ctxPayload.ThreadLabel).toBe("Fresh topic");
  });
});
