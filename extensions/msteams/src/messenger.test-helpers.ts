// Msteams test helpers build a Bot Framework app double and capture the activity a
// rendered message produces, so both the messenger tests and the reply-presentation
// tests assert against one send path.
import { vi } from "vitest";
import type { StoredConversationReference } from "./conversation-store.js";
import { sendMSTeamsMessages } from "./messenger.js";
import type { MSTeamsApp } from "./sdk.js";

export type MockAppOptions = {
  createFn?: (activity: unknown) => Promise<unknown>;
  onClientCreated?: (serviceUrl: string, conversationId: string) => void;
  onReference?: (ref: unknown) => void;
};

export function createMockApp(opts?: MockAppOptions): MSTeamsApp {
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

export async function buildActivity(
  message: Parameters<typeof sendMSTeamsMessages>[0]["messages"][number],
  conversationRef: StoredConversationReference,
  tokenProvider?: Parameters<typeof sendMSTeamsMessages>[0]["tokenProvider"],
  sharePointSiteId?: string,
  mediaMaxBytes?: number,
  options?: { feedbackLoopEnabled?: boolean },
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const app = createMockApp({
    createFn: async (activity) => {
      captured = activity as Record<string, unknown>;
      return { id: "captured" };
    },
  });
  await sendMSTeamsMessages({
    replyStyle: "top-level",
    app,
    appId: "app123",
    conversationRef,
    messages: [message],
    tokenProvider,
    sharePointSiteId,
    mediaMaxBytes,
    feedbackLoopEnabled: options?.feedbackLoopEnabled,
  });
  if (!captured) {
    throw new Error("expected Teams activity to be sent");
  }
  return captured;
}
