// Retry-scope regressions for sendMSTeamsMessages, split out of
// messenger.test.ts to keep that file under the max-lines budget:
// - send-stage ambiguous 408/5xx is never replayed (non-idempotent create);
// - pre-send Graph/SharePoint preparation failures stay retryable (nothing was
//   delivered) and keep their stage tag when they persist.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredConversationReference } from "./conversation-store.js";

const graphUploadMockState = vi.hoisted(() => ({
  uploadAndShareSharePoint: vi.fn(),
  getDriveItemProperties: vi.fn(),
}));

vi.mock("./graph-upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph-upload.js")>();
  return {
    ...actual,
    uploadAndShareSharePoint: graphUploadMockState.uploadAndShareSharePoint,
    getDriveItemProperties: graphUploadMockState.getDriveItemProperties,
  };
});

import { sendMSTeamsMessages } from "./messenger.js";
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

const baseRef: StoredConversationReference = {
  activityId: "activity123",
  user: { id: "user123", name: "User" },
  agent: { id: "bot123", name: "Bot" },
  conversation: { id: "19:abc@thread.tacv2;messageid=deadbeef" },
  channelId: "msteams",
  serviceUrl: "https://smba.trafficmanager.net/amer/",
};

describe("sendMSTeamsMessages retry scope", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
    graphUploadMockState.uploadAndShareSharePoint.mockReset();
    graphUploadMockState.getDriveItemProperties.mockReset();
  });

  it("does not retry top-level sends on ambiguous 5xx (duplicate-delivery risk)", async () => {
    const attempts: string[] = [];

    // The connector may already have accepted and delivered the activity
    // before returning 5xx, so the non-idempotent create must not be replayed.
    await expect(
      sendMSTeamsMessages({
        replyStyle: "top-level",
        app: createMockApp({
          createFn: createRecordedSendActivity(attempts, 503),
        }),
        appId: "app123",
        conversationRef: baseRef,
        messages: [{ text: "hello" }],
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    expect(attempts).toEqual(["hello"]);
  });

  it("retries pre-send upload 5xx (never delivered) and tags persistent failure as prepare-stage", async () => {
    const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-prepare-"));
    const localFile = path.join(tmpDir, "upload.txt");
    await writeFile(localFile, "hello");

    try {
      const attempts: string[] = [];
      let uploadAttempts = 0;
      graphUploadMockState.uploadAndShareSharePoint.mockImplementation(async () => {
        uploadAttempts += 1;
        throw Object.assign(new Error("graph upload 503"), { statusCode: 503 });
      });
      graphUploadMockState.getDriveItemProperties.mockResolvedValue({
        eTag: '"{ITEM-123},1"',
        webDavUrl: "https://sharepoint.example.com/item123",
        name: "upload.txt",
      });

      const ctx = {
        sendActivity: createRecordedSendActivity(attempts),
      };
      const err = await sendMSTeamsMessages({
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
        sharePointSiteId: "site-123",
        retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      }).catch((error: unknown) => error);

      // A pre-send 5xx is replayed (nothing was delivered, so a retry cannot
      // duplicate) and a persistent failure still surfaces as the platform
      // not-dispatched wrapper with the stage-tagged cause.
      expect(err).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect((err as PlatformMessageNotDispatchedError).cause).toMatchObject({
        statusCode: 503,
        msteamsSendStage: "prepare",
      });
      expect(uploadAttempts).toBe(3);
      expect(attempts).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("recovers when a pre-send upload 5xx succeeds on retry", async () => {
    const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-prepare-"));
    const localFile = path.join(tmpDir, "upload.txt");
    await writeFile(localFile, "hello");

    try {
      const attempts: string[] = [];
      let uploadAttempts = 0;
      graphUploadMockState.uploadAndShareSharePoint.mockImplementation(async () => {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          throw Object.assign(new Error("graph upload 503"), { statusCode: 503 });
        }
        return {
          itemId: "item123",
          webUrl: "https://sharepoint.example.com/item123",
          shareUrl: "https://sharepoint.example.com/share/item123",
          name: "upload.txt",
        };
      });
      graphUploadMockState.getDriveItemProperties.mockResolvedValue({
        eTag: '"{ITEM-123},1"',
        webDavUrl: "https://sharepoint.example.com/item123",
        name: "upload.txt",
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
        sharePointSiteId: "site-123",
        retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      });

      // Preparation reliability is preserved: a transient Graph 5xx before
      // the activity create is retried and the send completes.
      expect(uploadAttempts).toBe(2);
      expect(attempts).toEqual(["one"]);
      expect(ids).toEqual(["id:one"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
