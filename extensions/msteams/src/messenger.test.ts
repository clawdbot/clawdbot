import { beforeEach, describe, expect, it } from "vitest";

import { SILENT_REPLY_TOKEN, type PluginRuntime } from "clawdbot/plugin-sdk";
import type { StoredConversationReference } from "./conversation-store.js";
import {
  type MSTeamsAdapter,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages,
} from "./messenger.js";
import { setMSTeamsRuntime } from "./runtime.js";

const chunkMarkdownText = (text: string, limit: number) => {
  if (!text) return [];
  if (limit <= 0 || text.length <= limit) return [text];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks;
};

const runtimeStub = {
  channel: {
    text: {
      chunkMarkdownText,
      chunkMarkdownTextWithMode: chunkMarkdownText,
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

describe("msteams messenger", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
  });

  describe("renderReplyPayloadsToMessages", () => {
    it("filters silent replies", () => {
      const messages = renderReplyPayloadsToMessages([{ text: SILENT_REPLY_TOKEN }], {
        textChunkLimit: 4000,
        tableMode: "code",
      });
      expect(messages).toEqual([]);
    });

    it("filters silent reply prefixes", () => {
      const messages = renderReplyPayloadsToMessages(
        [{ text: `${SILENT_REPLY_TOKEN} -- ignored` }],
        { textChunkLimit: 4000, tableMode: "code" },
      );
      expect(messages).toEqual([]);
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
    const baseRef: StoredConversationReference = {
      activityId: "activity123",
      user: { id: "user123", name: "User" },
      agent: { id: "bot123", name: "Bot" },
      conversation: { id: "19:abc@thread.tacv2;messageid=deadbeef" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
    };

    it("sends thread messages via the provided context", async () => {
      const sent: string[] = [];
      const ctx = {
        sendActivity: async (activity: unknown) => {
          const { text } = activity as { text?: string };
          sent.push(text ?? "");
          return { id: `id:${text ?? ""}` };
        },
      };

      const adapter: MSTeamsAdapter = {
        continueConversation: async () => {},
      };

      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        adapter,
        appId: "app123",
        conversationRef: baseRef,
        context: ctx,
        messages: [{ text: "one" }, { text: "two" }],
      });

      expect(sent).toEqual(["one", "two"]);
      expect(ids).toEqual(["id:one", "id:two"]);
    });

    it("sends top-level messages via continueConversation and strips activityId", async () => {
      const seen: { reference?: unknown; texts: string[] } = { texts: [] };

      const adapter: MSTeamsAdapter = {
        continueConversation: async (_appId, reference, logic) => {
          seen.reference = reference;
          await logic({
            sendActivity: async (activity: unknown) => {
              const { text } = activity as { text?: string };
              seen.texts.push(text ?? "");
              return { id: `id:${text ?? ""}` };
            },
          });
        },
      };

      const ids = await sendMSTeamsMessages({
        replyStyle: "top-level",
        adapter,
        appId: "app123",
        conversationRef: baseRef,
        messages: [{ text: "hello" }],
      });

      expect(seen.texts).toEqual(["hello"]);
      expect(ids).toEqual(["id:hello"]);

      const ref = seen.reference as {
        activityId?: string;
        conversation?: { id?: string };
      };
      expect(ref.activityId).toBeUndefined();
      expect(ref.conversation?.id).toBe("19:abc@thread.tacv2");
    });

    it("retries thread sends on throttling (429)", async () => {
      const attempts: string[] = [];
      const retryEvents: Array<{ nextAttempt: number; delayMs: number }> = [];

      const ctx = {
        sendActivity: async (activity: unknown) => {
          const { text } = activity as { text?: string };
          attempts.push(text ?? "");
          if (attempts.length === 1) {
            throw Object.assign(new Error("throttled"), { statusCode: 429 });
          }
          return { id: `id:${text ?? ""}` };
        },
      };

      const adapter: MSTeamsAdapter = {
        continueConversation: async () => {},
      };

      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        adapter,
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

    it("does not retry thread sends on client errors (4xx)", async () => {
      const ctx = {
        sendActivity: async () => {
          throw Object.assign(new Error("bad request"), { statusCode: 400 });
        },
      };

      const adapter: MSTeamsAdapter = {
        continueConversation: async () => {},
      };

      await expect(
        sendMSTeamsMessages({
          replyStyle: "thread",
          adapter,
          appId: "app123",
          conversationRef: baseRef,
          context: ctx,
          messages: [{ text: "one" }],
          retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("retries top-level sends on transient (5xx)", async () => {
      const attempts: string[] = [];

      const adapter: MSTeamsAdapter = {
        continueConversation: async (_appId, _reference, logic) => {
          await logic({
            sendActivity: async (activity: unknown) => {
              const { text } = activity as { text?: string };
              attempts.push(text ?? "");
              if (attempts.length === 1) {
                throw Object.assign(new Error("server error"), {
                  statusCode: 503,
                });
              }
              return { id: `id:${text ?? ""}` };
            },
          });
        },
      };

      const ids = await sendMSTeamsMessages({
        replyStyle: "top-level",
        adapter,
        appId: "app123",
        conversationRef: baseRef,
        messages: [{ text: "hello" }],
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      });

      expect(attempts).toEqual(["hello", "hello"]);
      expect(ids).toEqual(["id:hello"]);
    });
  });
});
