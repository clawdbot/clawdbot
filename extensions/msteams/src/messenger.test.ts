// Msteams tests cover messenger plugin behavior.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SILENT_REPLY_TOKEN } from "openclaw/plugin-sdk/reply-chunking";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredConversationReference } from "./conversation-store.js";
const graphUploadMockState = vi.hoisted(() => ({
  uploadAndShareOneDrive: vi.fn(),
  uploadAndShareSharePoint: vi.fn(),
  getDriveItemProperties: vi.fn(),
}));

vi.mock("./graph-upload.js", () => {
  return {
    uploadAndShareOneDrive: graphUploadMockState.uploadAndShareOneDrive,
    uploadAndShareSharePoint: graphUploadMockState.uploadAndShareSharePoint,
    getDriveItemProperties: graphUploadMockState.getDriveItemProperties,
  };
});

import {
  buildActivity,
  buildConversationReference,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages,
} from "./messenger.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsApp } from "./sdk.js";

const chunkMarkdownText = (text: string, limit: number) => {
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks;
};

const runtimeStub = {
  config: {
    loadConfig: () => ({}),
  },
  channel: {
    text: {
      chunkMarkdownText,
      chunkMarkdownTextWithMode: chunkMarkdownText,
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

const createRecordedSendActivity = (
  sink: string[],
  failFirstWithStatusCode?: number,
): ((activity: unknown) => Promise<{ id: string }>) => {
  let attempts = 0;
  return async (activity: unknown) => {
    const { text } = activity as { text?: string };
    const content = text ?? "";
    sink.push(content);
    attempts += 1;
    if (failFirstWithStatusCode !== undefined && attempts === 1) {
      throw Object.assign(new Error("send failed"), { statusCode: failFirstWithStatusCode });
    }
    return { id: `id:${content}` };
  };
};

const REVOCATION_ERROR = "Cannot perform 'set' on a proxy that has been revoked";

function requireSentMessage(sent: Array<{ text?: string; entities?: unknown[] }>) {
  const firstSent = sent[0];
  if (!firstSent?.text) {
    throw new Error("expected Teams message send to include rendered text");
  }
  return firstSent;
}

function findEntity(
  entities: unknown,
  predicate: (entity: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  return (entities as Array<Record<string, unknown>> | undefined)?.find(predicate);
}

function requireAiGeneratedEntity(entities: unknown): Record<string, unknown> {
  const entity = findEntity(
    entities,
    (candidate) =>
      Array.isArray(candidate.additionalType) &&
      candidate.additionalType.includes("AIGeneratedContent"),
  );
  if (!entity) {
    throw new Error("expected Teams AI-generated entity");
  }
  return entity;
}

function requireMentionEntity(entities: unknown): Record<string, unknown> {
  const entity = findEntity(entities, (candidate) => candidate.type === "mention");
  if (!entity) {
    throw new Error("expected Teams mention entity");
  }
  return entity;
}

type MockAppOptions = {
  createFn?: (activity: unknown) => Promise<unknown>;
  onClientCreated?: (serviceUrl: string, conversationId: string) => void;
  onReference?: (ref: unknown) => void;
};

function createMockApp(opts?: MockAppOptions): MSTeamsApp {
  const createFn =
    opts?.createFn ??
    (async (activity: unknown) => {
      const text = (activity as Record<string, unknown>)?.text;
      return { id: typeof text === "string" ? `id:${text}` : "created" };
    });
  const apiServiceUrl = "https://smba.trafficmanager.net/amer";
  return {
    client: { request: vi.fn() },
    tokenManager: {
      getBotToken: async () => ({ toString: () => "bot-token" }),
      getGraphToken: async () => ({ toString: () => "graph-token" }),
    },
    send: async (conversationId: string, activity: unknown) => {
      opts?.onClientCreated?.("", conversationId);
      return await createFn(activity);
    },
    activitySender: {
      send: async (
        activity: unknown,
        ref: { serviceUrl?: string; conversation?: { id?: string } },
      ) => {
        opts?.onReference?.(ref);
        opts?.onClientCreated?.(ref.serviceUrl ?? "", ref.conversation?.id ?? "");
        return await createFn(activity);
      },
    },
    // Mirror the SDK's `app.reply` which internally calls
    // `app.send(toThreadedConversationId(channelId, msgId), activity)`. The
    // test capture sees the threaded conversationId so existing assertions
    // continue to work after we switched messenger.ts from manual URL
    // construction to `app.reply`.
    reply: async (conversationId: string, messageId: string, activity: unknown) => {
      const threaded = `${conversationId};messageid=${messageId}`;
      opts?.onClientCreated?.("", threaded);
      return await createFn(activity);
    },
    api: {
      serviceUrl: apiServiceUrl,
      conversations: {
        activities: (conversationId: string) => {
          opts?.onClientCreated?.(apiServiceUrl, conversationId);
          return {
            create: async (activity: unknown) => {
              opts?.onReference?.({ serviceUrl: apiServiceUrl, ...(activity as object) });
              return createFn(activity);
            },
            update: async (_id: string, activity: unknown) => ({
              id: (activity as Record<string, unknown>)?.id ?? "updated",
            }),
            delete: async () => {},
          };
        },
      },
    },
  } as unknown as MSTeamsApp;
}

describe("msteams messenger", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
    graphUploadMockState.uploadAndShareOneDrive.mockReset();
    graphUploadMockState.uploadAndShareSharePoint.mockReset();
    graphUploadMockState.getDriveItemProperties.mockReset();
    graphUploadMockState.uploadAndShareOneDrive.mockResolvedValue({
      itemId: "item123",
      webUrl: "https://onedrive.example.com/item123",
      shareUrl: "https://onedrive.example.com/share/item123",
      name: "upload.txt",
    });
  });

  describe("renderReplyPayloadsToMessages", () => {
    it("filters silent replies", () => {
      const messages = renderReplyPayloadsToMessages([{ text: SILENT_REPLY_TOKEN }], {
        textChunkLimit: 4000,
        tableMode: "code",
      });
      expect(messages).toStrictEqual([]);
    });

    it("does not filter non-exact silent reply prefixes", () => {
      const messages = renderReplyPayloadsToMessages(
        [{ text: `${SILENT_REPLY_TOKEN} -- ignored` }],
        { textChunkLimit: 4000, tableMode: "code" },
      );
      expect(messages).toEqual([{ text: `${SILENT_REPLY_TOKEN} -- ignored` }]);
    });

    it("splits media into separate messages by default", () => {
      const messages = renderReplyPayloadsToMessages(
        [{ text: "hi", mediaUrl: "https://example.com/a.png" }],
        { textChunkLimit: 4000, tableMode: "code" },
      );
      expect(messages).toEqual([{ text: "hi" }, { mediaUrl: "https://example.com/a.png" }]);
    });

    it("supports inline media mode", () => {
      const messages = renderReplyPayloadsToMessages(
        [{ text: "hi", mediaUrl: "https://example.com/a.png" }],
        { textChunkLimit: 4000, mediaMode: "inline", tableMode: "code" },
      );
      expect(messages).toEqual([{ text: "hi", mediaUrl: "https://example.com/a.png" }]);
    });

    it("chunks long text when enabled", () => {
      const long = "hello ".repeat(200);
      const messages = renderReplyPayloadsToMessages([{ text: long }], {
        textChunkLimit: 50,
        tableMode: "code",
      });
      expect(messages.length).toBeGreaterThan(1);
    });
  });

  describe("sendMSTeamsMessages", () => {
    function createRevokedThreadContext(params?: { failAfterAttempt?: number; sent?: string[] }) {
      let attempt = 0;
      return {
        sendActivity: async (activity: unknown) => {
          const { text } = activity as { text?: string };
          const content = text ?? "";
          attempt += 1;
          if (params?.failAfterAttempt && attempt < params.failAfterAttempt) {
            params.sent?.push(content);
            return { id: `id:${content}` };
          }
          throw new TypeError(REVOCATION_ERROR);
        },
      };
    }

    const baseRef: StoredConversationReference = {
      activityId: "activity123",
      user: { id: "user123", name: "User" },
      agent: { id: "bot123", name: "Bot" },
      conversation: { id: "19:abc@thread.tacv2;messageid=deadbeef" },
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    };

    async function sendAndCaptureRevokeFallbackReference(params: {
      conversation: StoredConversationReference["conversation"];
      activityId?: string;
      threadId?: string;
    }) {
      const proactiveSent: string[] = [];
      let capturedConversationId: string | undefined;
      const conversationRef: StoredConversationReference = {
        activityId: params.activityId ?? "activity456",
        user: { id: "user123", name: "User" },
        agent: { id: "bot123", name: "Bot" },
        conversation: params.conversation,
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        ...(params.threadId ? { threadId: params.threadId } : {}),
      };

      await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp({
          createFn: createRecordedSendActivity(proactiveSent),
          onClientCreated: (_serviceUrl, conversationId) => {
            capturedConversationId = conversationId;
          },
        }),
        appId: "app123",
        conversationRef,
        context: createRevokedThreadContext(),
        messages: [{ text: "hello" }],
      });

      return {
        proactiveSent,
        // Reconstruct a reference-like shape from captured conversationId for assertion compat
        reference: {
          conversation: capturedConversationId ? { id: capturedConversationId } : undefined,
          activityId: undefined,
        },
      };
    }

    it("sends thread messages via the provided context", async () => {
      const sent: string[] = [];
      const ctx = {
        sendActivity: createRecordedSendActivity(sent),
      };
      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp(),
        appId: "app123",
        conversationRef: baseRef,
        context: ctx,
        messages: [{ text: "one" }, { text: "two" }],
      });

      expect(sent).toEqual(["one", "two"]);
      expect(ids).toEqual(["id:one", "id:two"]);
    });

    it("sends top-level messages via proactive send context", async () => {
      const texts: string[] = [];
      let capturedConversationId: string | undefined;

      const ids = await sendMSTeamsMessages({
        replyStyle: "top-level",
        app: createMockApp({
          createFn: async (activity: unknown) => {
            const text = (activity as Record<string, unknown>)?.text;
            texts.push(typeof text === "string" ? text : "");
            return { id: typeof text === "string" ? `id:${text}` : "created" };
          },
          onClientCreated: (_serviceUrl, conversationId) => {
            capturedConversationId = conversationId;
          },
        }),
        appId: "app123",
        conversationRef: baseRef,
        messages: [{ text: "hello" }],
      });

      expect(texts).toEqual(["hello"]);
      expect(ids).toEqual(["id:hello"]);
      expect(capturedConversationId).toBe("19:abc@thread.tacv2");
    });

    it("preserves parsed mentions when appending OneDrive fallback file links", async () => {
      const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-mention-"));
      const localFile = path.join(tmpDir, "note.txt");
      await writeFile(localFile, "hello");

      try {
        const sent: Array<{ text?: string; entities?: unknown[] }> = [];
        const ctx = {
          sendActivity: async (activity: unknown) => {
            sent.push(activity as { text?: string; entities?: unknown[] });
            return { id: "id:one" };
          },
        };

        const ids = await sendMSTeamsMessages({
          replyStyle: "thread",
          app: createMockApp(),
          appId: "app123",
          conversationRef: {
            ...baseRef,
            conversation: {
              ...baseRef.conversation,
              conversationType: "channel",
            },
          },
          context: ctx,
          messages: [{ text: "Hello @[John](29:08q2j2o3jc09au90eucae)", mediaUrl: localFile }],
          tokenProvider: {
            getAccessToken: async () => "token",
          },
        });

        expect(ids).toEqual(["id:one"]);
        expect(graphUploadMockState.uploadAndShareOneDrive).toHaveBeenCalledOnce();
        expect(sent).toHaveLength(1);
        const firstSent = requireSentMessage(sent);
        expect(firstSent.text).toContain("Hello <at>John</at>");
        expect(firstSent.text).toContain(
          "📎 [upload.txt](https://onedrive.example.com/share/item123)",
        );
        const mentionEntity = requireMentionEntity(sent[0]?.entities);
        expect(mentionEntity.text).toBe("<at>John</at>");
        expect(mentionEntity.mentioned).toEqual({
          id: "29:08q2j2o3jc09au90eucae",
          name: "John",
        });
        expect(requireAiGeneratedEntity(sent[0]?.entities).additionalType).toEqual([
          "AIGeneratedContent",
        ]);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("retries thread sends on throttling (429)", async () => {
      const attempts: string[] = [];
      const retryEvents: Array<{ nextAttempt: number; delayMs: number }> = [];

      const ctx = {
        sendActivity: createRecordedSendActivity(attempts, 429),
      };
      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp(),
        appId: "app123",
        conversationRef: baseRef,
        context: ctx,
        messages: [{ text: "one" }],
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        onRetry: (e) => retryEvents.push({ nextAttempt: e.nextAttempt, delayMs: e.delayMs }),
      });

      expect(attempts).toEqual(["one", "one"]);
      expect(ids).toEqual(["id:one"]);
      expect(retryEvents).toEqual([{ nextAttempt: 2, delayMs: 0 }]);
    });

    it("retries full activity preparation when media upload fails transiently", async () => {
      const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-retry-"));
      const localFile = path.join(tmpDir, "retry.txt");
      await writeFile(localFile, "hello");

      try {
        const attempts: string[] = [];
        const retryEvents: Array<{ nextAttempt: number; delayMs: number }> = [];
        let uploadAttempts = 0;
        graphUploadMockState.uploadAndShareOneDrive.mockImplementation(async () => {
          uploadAttempts += 1;
          if (uploadAttempts === 1) {
            throw Object.assign(new Error("transient upload failure"), { statusCode: 429 });
          }
          return {
            itemId: "item123",
            webUrl: "https://onedrive.example.com/item123",
            shareUrl: "https://onedrive.example.com/share/item123",
            name: "retry.txt",
          };
        });

        const ctx = {
          sendActivity: createRecordedSendActivity(attempts),
        };
        const ids = await sendMSTeamsMessages({
          replyStyle: "thread",
          app: createMockApp(),
          appId: "app123",
          conversationRef: {
            ...baseRef,
            conversation: {
              ...baseRef.conversation,
              conversationType: "channel",
            },
          },
          context: ctx,
          messages: [{ text: "one", mediaUrl: localFile }],
          tokenProvider: {
            getAccessToken: async () => "token",
          },
          retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
          onRetry: (e) => retryEvents.push({ nextAttempt: e.nextAttempt, delayMs: e.delayMs }),
        });

        expect(uploadAttempts).toBe(2);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toContain("📎 [retry.txt]");
        expect(ids).toEqual([`id:${attempts[0]}`]);
        expect(retryEvents).toEqual([{ nextAttempt: 2, delayMs: 0 }]);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not retry thread sends on client errors (4xx)", async () => {
      const ctx = {
        sendActivity: async () => {
          throw Object.assign(new Error("bad request"), { statusCode: 400 });
        },
      };

      await expect(
        sendMSTeamsMessages({
          replyStyle: "thread",
          app: createMockApp(),
          appId: "app123",
          conversationRef: baseRef,
          context: ctx,
          messages: [{ text: "one" }],
          retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("falls back to proactive messaging when thread context is revoked", async () => {
      const proactiveSent: string[] = [];
      const ctx = createRevokedThreadContext();

      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp({ createFn: createRecordedSendActivity(proactiveSent) }),
        appId: "app123",
        conversationRef: baseRef,
        context: ctx,
        messages: [{ text: "hello" }],
      });

      // Should have fallen back to proactive messaging
      expect(proactiveSent).toEqual(["hello"]);
      expect(ids).toEqual(["id:hello"]);
    });

    it("falls back only for remaining thread messages after context revocation", async () => {
      const threadSent: string[] = [];
      const proactiveSent: string[] = [];
      const ctx = createRevokedThreadContext({ failAfterAttempt: 2, sent: threadSent });

      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp({ createFn: createRecordedSendActivity(proactiveSent) }),
        appId: "app123",
        conversationRef: baseRef,
        context: ctx,
        messages: [{ text: "one" }, { text: "two" }, { text: "three" }],
      });

      expect(threadSent).toEqual(["one"]);
      expect(proactiveSent).toEqual(["two", "three"]);
      expect(ids).toEqual(["id:one", "id:two", "id:three"]);
    });

    it("reconstructs threaded conversation ID for channel revoke fallback", async () => {
      const { proactiveSent, reference } = await sendAndCaptureRevokeFallbackReference({
        conversation: {
          id: "19:abc@thread.tacv2;messageid=deadbeef",
          conversationType: "channel",
        },
      });

      expect(proactiveSent).toEqual(["hello"]);
      // Conversation ID should include the thread suffix for channel messages
      expect(reference.conversation?.id).toBe("19:abc@thread.tacv2;messageid=activity456");
      expect(reference.activityId).toBeUndefined();
    });

    it("does not add thread suffix for group chat revoke fallback", async () => {
      const { proactiveSent, reference } = await sendAndCaptureRevokeFallbackReference({
        conversation: {
          id: "19:group123@thread.v2",
          conversationType: "groupChat",
        },
      });

      expect(proactiveSent).toEqual(["hello"]);
      // Group chat should NOT have thread suffix — flat conversation
      expect(reference.conversation?.id).toBe("19:group123@thread.v2");
      expect(reference.activityId).toBeUndefined();
    });

    it("uses threadId instead of activityId for channel revoke fallback (#58030)", async () => {
      const { proactiveSent, reference } = await sendAndCaptureRevokeFallbackReference({
        activityId: "current-message-id",
        conversation: {
          id: "19:abc@thread.tacv2",
          conversationType: "channel",
        },
        // threadId is the thread root, which differs from activityId (current message)
        threadId: "thread-root-msg-id",
      });

      expect(proactiveSent).toEqual(["hello"]);
      // Should use threadId (thread root), NOT activityId (current message)
      expect(reference.conversation?.id).toBe("19:abc@thread.tacv2;messageid=thread-root-msg-id");
      expect(reference.activityId).toBeUndefined();
    });

    it("falls back to activityId when threadId is not set (backward compat)", async () => {
      const { proactiveSent, reference } = await sendAndCaptureRevokeFallbackReference({
        activityId: "legacy-activity-id",
        conversation: {
          id: "19:abc@thread.tacv2",
          conversationType: "channel",
        },
        // No threadId — older stored references may not have it
      });

      expect(proactiveSent).toEqual(["hello"]);
      // Falls back to activityId when threadId is missing
      expect(reference.conversation?.id).toBe("19:abc@thread.tacv2;messageid=legacy-activity-id");
    });

    it("sends no-context thread replies proactively with the channel thread root", async () => {
      const sent: string[] = [];
      const channelRef: StoredConversationReference = {
        activityId: "current-msg",
        user: { id: "user123", name: "User" },
        agent: { id: "bot123", name: "Bot" },
        conversation: {
          id: "19:abc@thread.tacv2",
          conversationType: "channel",
        },
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        threadId: "thread-root-msg-id",
      };

      let capturedConversationId: string | undefined;
      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp({
          createFn: createRecordedSendActivity(sent),
          onClientCreated: (_serviceUrl, conversationId) => {
            capturedConversationId = conversationId;
          },
        }),
        appId: "app123",
        conversationRef: channelRef,
        messages: [{ text: "hello" }],
      });
      expect(sent).toEqual(["hello"]);
      expect(ids).toEqual(["id:hello"]);
      expect(capturedConversationId).toBe("19:abc@thread.tacv2;messageid=thread-root-msg-id");
    });

    it("uses activityId for no-context thread replies when threadId is absent", async () => {
      const sent: string[] = [];
      const channelRef: StoredConversationReference = {
        activityId: "legacy-activity-id",
        user: { id: "user123", name: "User" },
        agent: { id: "bot123", name: "Bot" },
        conversation: {
          id: "19:abc@thread.tacv2",
          conversationType: "channel",
        },
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
      };

      let capturedConversationId: string | undefined;
      await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp({
          createFn: createRecordedSendActivity(sent),
          onClientCreated: (_serviceUrl, conversationId) => {
            capturedConversationId = conversationId;
          },
        }),
        appId: "app123",
        conversationRef: channelRef,
        messages: [{ text: "hello" }],
      });

      expect(sent).toEqual(["hello"]);
      expect(capturedConversationId).toBe("19:abc@thread.tacv2;messageid=legacy-activity-id");
    });

    it("does not add thread suffix for top-level replyStyle even with threadId set", async () => {
      const sent: string[] = [];
      let capturedConversationId: string | undefined;

      const channelRef: StoredConversationReference = {
        activityId: "current-msg",
        user: { id: "user123", name: "User" },
        agent: { id: "bot123", name: "Bot" },
        conversation: {
          id: "19:abc@thread.tacv2",
          conversationType: "channel",
        },
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        threadId: "thread-root-msg-id",
      };

      await sendMSTeamsMessages({
        replyStyle: "top-level",
        app: createMockApp({
          createFn: createRecordedSendActivity(sent),
          onClientCreated: (_serviceUrl, conversationId) => {
            capturedConversationId = conversationId;
          },
        }),
        appId: "app123",
        conversationRef: channelRef,
        messages: [{ text: "hello" }],
      });

      expect(sent).toEqual(["hello"]);
      // Top-level sends should NOT include thread suffix
      expect(capturedConversationId).toBe("19:abc@thread.tacv2");
    });

    it("retries top-level sends on transient (5xx)", async () => {
      const attempts: string[] = [];

      const ids = await sendMSTeamsMessages({
        replyStyle: "top-level",
        app: createMockApp({
          createFn: createRecordedSendActivity(attempts, 503),
        }),
        appId: "app123",
        conversationRef: baseRef,
        messages: [{ text: "hello" }],
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      });

      expect(attempts).toEqual(["hello", "hello"]);
      expect(ids).toEqual(["id:hello"]);
    });

    it("delivers all blocks in a multi-block reply via a single proactive send context (#29379)", async () => {
      // Regression: multiple text blocks (e.g. text -> tool -> text) must all
      // reach the user. The fix batches all rendered messages into one
      // sendMSTeamsMessages call so they share a single proactive send context.
      const allTexts: string[] = [];
      let clientCreations = 0;

      // Three blocks (text + code + text) sent together in one call.
      const ids = await sendMSTeamsMessages({
        replyStyle: "top-level",
        app: createMockApp({
          createFn: async (activity: unknown) => {
            const { text } = activity as { text?: string };
            allTexts.push(text ?? "");
            return { id: `id:${text ?? ""}` };
          },
          onClientCreated: () => {
            clientCreations += 1;
          },
        }),
        appId: "app123",
        conversationRef: baseRef,
        messages: [
          { text: "Let me look that up..." },
          { text: "```\nresult = 42\n```" },
          { text: "The answer is 42." },
        ],
      });

      // All three blocks delivered.
      expect(ids).toHaveLength(3);
      expect(allTexts).toEqual([
        "Let me look that up...",
        "```\nresult = 42\n```",
        "The answer is 42.",
      ]);
    });
  });

  describe("buildActivity AI metadata", () => {
    const baseRef: StoredConversationReference = {
      activityId: "activity123",
      user: { id: "user123", name: "User" },
      agent: { id: "bot123", name: "Bot" },
      conversation: { id: "conv123", conversationType: "personal" },
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    };

    it("adds AI-generated entity to text messages", async () => {
      const activity = await buildActivity({ text: "hello" }, baseRef);
      const aiEntity = requireAiGeneratedEntity(activity.entities);
      expect(aiEntity.type).toBe("https://schema.org/Message");
      expect(aiEntity["@type"]).toBe("Message");
      expect(aiEntity.additionalType).toEqual(["AIGeneratedContent"]);
    });

    it("adds AI-generated entity to media-only messages", async () => {
      const activity = await buildActivity({ mediaUrl: "https://example.com/img.png" }, baseRef);
      expect(requireAiGeneratedEntity(activity.entities).additionalType).toEqual([
        "AIGeneratedContent",
      ]);
    });

    it("preserves mention entities alongside AI entity", async () => {
      const activity = await buildActivity({ text: "hi <at>@User</at>" }, baseRef);
      const entities = activity.entities as Array<Record<string, unknown>>;
      // Should have at least the AI entity
      expect(entities.length).toBeGreaterThanOrEqual(1);
      expect(requireAiGeneratedEntity(entities).additionalType).toEqual(["AIGeneratedContent"]);
    });

    it("sets feedbackLoopEnabled in channelData when enabled", async () => {
      const activity = await buildActivity(
        { text: "hello" },
        baseRef,
        undefined,
        undefined,
        undefined,
        {
          feedbackLoopEnabled: true,
        },
      );
      const channelData = activity.channelData as Record<string, unknown>;
      expect(channelData.feedbackLoopEnabled).toBe(true);
    });

    it("defaults feedbackLoopEnabled to false", async () => {
      const activity = await buildActivity({ text: "hello" }, baseRef);
      const channelData = activity.channelData as Record<string, unknown>;
      expect(channelData.feedbackLoopEnabled).toBe(false);
    });
  });

  // Regression coverage for #58774: proactive Teams sends fail with HTTP 403
  // when the Bot Framework connector does not see `tenantId` / `aadObjectId`
  // on the outbound conversation reference.
  describe("buildConversationReference tenant/aad forwarding (#58774)", () => {
    const storedWithChannelDataTenant: StoredConversationReference = {
      activityId: "activity-1",
      user: { id: "user123", name: "User", aadObjectId: "aad-user-123" },
      agent: { id: "bot123", name: "Bot" },
      conversation: {
        id: "19:abc@thread.tacv2",
        conversationType: "channel",
      },
      // Canonical channelData source captured by message-handler inbound code.
      tenantId: "tenant-abc",
      aadObjectId: "aad-user-123",
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    };

    it("forwards top-level tenantId and aadObjectId onto the outbound reference", () => {
      const reference = buildConversationReference(storedWithChannelDataTenant);
      expect(reference.tenantId).toBe("tenant-abc");
      expect(reference.aadObjectId).toBe("aad-user-123");
      expect(reference.conversation.tenantId).toBe("tenant-abc");
      expect(reference.user?.aadObjectId).toBe("aad-user-123");
    });

    it("falls back to conversation.tenantId when no top-level tenantId is stored (legacy ref)", () => {
      const legacy: StoredConversationReference = {
        activityId: "activity-legacy",
        user: { id: "user-legacy", name: "Legacy", aadObjectId: "aad-legacy" },
        agent: { id: "bot-legacy", name: "Bot" },
        conversation: {
          id: "a:personal-chat",
          conversationType: "personal",
          tenantId: "tenant-legacy",
        },
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
      };
      const reference = buildConversationReference(legacy);
      expect(reference.tenantId).toBe("tenant-legacy");
      expect(reference.aadObjectId).toBe("aad-legacy");
    });

    it("omits tenantId and aadObjectId when neither source is available", () => {
      const minimal: StoredConversationReference = {
        activityId: "activity-2",
        user: { id: "user456", name: "User" },
        agent: { id: "bot456", name: "Bot" },
        conversation: { id: "19:xyz@thread.tacv2", conversationType: "channel" },
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
      };
      const reference = buildConversationReference(minimal);
      expect(reference.tenantId).toBeUndefined();
      expect(reference.aadObjectId).toBeUndefined();
      expect(reference.conversation.tenantId).toBeUndefined();
    });

    it("propagates tenantId/aadObjectId through sendMSTeamsMessages proactive path", async () => {
      const sent: string[] = [];
      const refs: unknown[] = [];

      const ids = await sendMSTeamsMessages({
        replyStyle: "top-level",
        app: createMockApp({
          createFn: createRecordedSendActivity(sent),
          onReference: (ref) => refs.push(ref),
        }),
        appId: "app123",
        conversationRef: storedWithChannelDataTenant,
        messages: [{ text: "hello" }],
      });

      expect(sent).toEqual(["hello"]);
      expect(ids).toEqual(["id:hello"]);
      expect(refs).toEqual([
        expect.objectContaining({
          serviceUrl: "https://smba.trafficmanager.net/amer",
          tenantId: "tenant-abc",
          aadObjectId: "aad-user-123",
          conversation: expect.objectContaining({
            id: "19:abc@thread.tacv2",
            tenantId: "tenant-abc",
          }),
          recipient: expect.objectContaining({ aadObjectId: "aad-user-123" }),
        }),
      ]);
      const ref = buildConversationReference(storedWithChannelDataTenant);
      expect(ref.tenantId).toBe("tenant-abc");
      expect(ref.aadObjectId).toBe("aad-user-123");
    });
  });
});
