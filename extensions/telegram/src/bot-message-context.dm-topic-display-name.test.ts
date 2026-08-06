// Telegram tests cover direct-topic session-label synchronization.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getSessionEntry,
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import type { TelegramMessageContextSessionRuntimeOverrides } from "./bot-message-context.types.js";
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
  replyCreatedName?: string;
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
    ...(params.replyCreatedName !== undefined
      ? {
          reply_to_message: {
            forum_topic_created: {
              name: params.replyCreatedName,
              icon_color: 0x6fb9f0,
            },
          },
        }
      : {}),
  };
}

async function buildDirectTopicContext(params: {
  cfg: ReturnType<typeof createConfig>;
  message: ReturnType<typeof directTopicMessage>;
  accountId?: string;
  dmPolicy?: "disabled" | "open";
  hasTopicsEnabled?: boolean;
  sessionRuntime?: TelegramMessageContextSessionRuntimeOverrides;
}) {
  return await buildTelegramMessageContextForTest({
    cfg: params.cfg,
    me: { has_topics_enabled: params.hasTopicsEnabled ?? true },
    message: params.message,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.dmPolicy ? { dmPolicy: params.dmPolicy } : {}),
    sessionRuntime: params.sessionRuntime ?? null,
  });
}

afterEach(async () => {
  resetTelegramTopicNameCacheForTest();
  if (tempDir) {
    await fs.rm(tempDir, { force: true, recursive: true });
    tempDir = undefined;
  }
});

describe("buildTelegramMessageContext direct topic display names", () => {
  it("updates the topic display name while preserving the Control UI label", async () => {
    const storePath = await createStore();
    const cfg = createConfig(storePath);
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "existing-session",
        updatedAt: 1_700_000_000_000,
        label: "Manual Control UI name",
        displayName: "Old Telegram topic",
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
      label: "Manual Control UI name",
      displayName: "First rename",
      updatedAt: 1_700_000_000_000,
    });

    await expect(
      buildDirectTopicContext({
        cfg,
        message: directTopicMessage({ messageId: 2, editedName: "Second rename" }),
      }),
    ).resolves.toBeNull();
    expect(getSessionEntry({ storePath, sessionKey })).toMatchObject({
      label: "Manual Control UI name",
      displayName: "Second rename",
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
        displayName: "Existing Telegram topic",
      },
    });

    await expect(
      buildDirectTopicContext({
        cfg,
        message: directTopicMessage({ messageId: 1, iconCustomEmojiId: "emoji-1" }),
      }),
    ).resolves.toBeNull();

    expect(getSessionEntry({ storePath, sessionKey })).toMatchObject({
      label: "Existing topic",
      displayName: "Existing Telegram topic",
    });
  });

  it("does not relabel the flat DM session when topic sessions are disabled", async () => {
    const storePath = await createStore();
    const cfg = createConfig(storePath);
    const flatSessionKey = "agent:main:main";
    await upsertSessionEntry({
      storePath,
      sessionKey: flatSessionKey,
      entry: {
        sessionId: "flat-session",
        updatedAt: 1_700_000_000_000,
        label: "Main DM",
      },
    });

    await expect(
      buildDirectTopicContext({
        cfg,
        hasTopicsEnabled: false,
        message: directTopicMessage({ messageId: 1, editedName: "Topic rename" }),
      }),
    ).resolves.toBeNull();

    expect(getSessionEntry({ storePath, sessionKey: flatSessionKey })?.label).toBe("Main DM");
    const context = await buildDirectTopicContext({
      cfg,
      hasTopicsEnabled: false,
      message: directTopicMessage({ messageId: 2, text: "hello" }),
    });
    expect(context?.ctxPayload.SessionKey).toBe(flatSessionKey);
    expect(context?.ctxPayload.ThreadLabel).toBeUndefined();
    expect(context?.ctxPayload.TopicName).toBeUndefined();
  });

  it("propagates a failed display-name write for ingress retry", async () => {
    const storePath = await createStore();
    const cfg = createConfig(storePath);
    const writeFailure = new Error("session store unavailable");

    await expect(
      buildDirectTopicContext({
        cfg,
        message: directTopicMessage({ messageId: 1, editedName: "Retry this rename" }),
        sessionRuntime: {
          resolveStorePath: () => storePath,
          patchSessionEntry: vi.fn(async () => {
            throw writeFailure;
          }),
        },
      }),
    ).rejects.toThrow(writeFailure);
  });

  it("does not cache topic names from rejected direct messages", async () => {
    const storePath = await createStore();
    const cfg = createConfig(storePath);

    await expect(
      buildDirectTopicContext({
        cfg,
        dmPolicy: "disabled",
        message: directTopicMessage({ messageId: 1, createdName: "Rejected title" }),
      }),
    ).resolves.toBeNull();

    const context = await buildDirectTopicContext({
      cfg,
      dmPolicy: "open",
      message: directTopicMessage({ messageId: 2, text: "hello" }),
    });
    expect(context?.ctxPayload.ThreadLabel).toBeUndefined();
  });

  it("keeps direct-topic caches isolated by Telegram account", async () => {
    const storePath = await createStore();
    const cfg = createConfig(storePath);

    await buildDirectTopicContext({
      cfg,
      accountId: "work",
      message: directTopicMessage({ messageId: 1, createdName: "Work topic" }),
    });
    await buildDirectTopicContext({
      cfg,
      accountId: "personal",
      message: directTopicMessage({ messageId: 2, createdName: "Personal topic" }),
    });

    const workContext = await buildDirectTopicContext({
      cfg,
      accountId: "work",
      message: directTopicMessage({ messageId: 3, text: "hello" }),
    });
    const personalContext = await buildDirectTopicContext({
      cfg,
      accountId: "personal",
      message: directTopicMessage({ messageId: 4, text: "hello" }),
    });
    expect(workContext?.ctxPayload.ThreadLabel).toBe("Work topic");
    expect(personalContext?.ctxPayload.ThreadLabel).toBe("Personal topic");
  });

  it("does not restore stale direct-topic names from reply ancestry", async () => {
    const storePath = await createStore();
    const cfg = createConfig(storePath);

    const context = await buildDirectTopicContext({
      cfg,
      message: directTopicMessage({
        messageId: 1,
        replyCreatedName: "Original topic name",
        text: "hello",
      }),
    });

    expect(context?.ctxPayload.ThreadLabel).toBeUndefined();
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
    expect(context?.ctxPayload.ConversationLabel).toBe("Fresh topic");
    expect(context?.ctxPayload.ThreadLabel).toBe("Fresh topic");
    expect(context?.ctxPayload.TopicName).toBe("Fresh topic");
  });
});
