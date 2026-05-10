import { WebSocket } from "ws";
import type {
  ClickClackChannel,
  ClickClackEvent,
  ClickClackMessage,
  ClickClackUser,
  ClickClackWorkspace,
} from "./types.js";

type ClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
};

export function createClickClackClient(options: ClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetcher = options.fetch ?? fetch;
  const headers = {
    Authorization: `Bearer ${options.token}`,
    Accept: "application/json",
  };

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const requestHeaders = new Headers(init.headers);
    for (const [key, value] of Object.entries(headers)) {
      requestHeaders.set(key, value);
    }
    if (init.body && !(init.body instanceof FormData)) {
      requestHeaders.set("Content-Type", "application/json");
    }
    const response = await fetcher(`${baseUrl}${path}`, { ...init, headers: requestHeaders });
    if (!response.ok) {
      throw new Error(`ClickClack ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  return {
    me: async (): Promise<ClickClackUser> => {
      const data = await request<{ user: ClickClackUser }>("/api/me");
      return data.user;
    },
    workspaces: async (): Promise<ClickClackWorkspace[]> => {
      const data = await request<{ workspaces: ClickClackWorkspace[] }>("/api/workspaces");
      return data.workspaces;
    },
    channels: async (workspaceId: string): Promise<ClickClackChannel[]> => {
      const data = await request<{ channels: ClickClackChannel[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/channels`,
      );
      return data.channels;
    },
    channelMessages: async (
      channelId: string,
      afterSeq: number,
      limit = 20,
    ): Promise<ClickClackMessage[]> => {
      const data = await request<{ messages: ClickClackMessage[] }>(
        `/api/channels/${encodeURIComponent(channelId)}/messages?after_seq=${afterSeq}&limit=${limit}`,
      );
      return data.messages;
    },
    directMessages: async (
      conversationId: string,
      afterSeq: number,
      limit = 20,
    ): Promise<ClickClackMessage[]> => {
      const data = await request<{ messages: ClickClackMessage[] }>(
        `/api/dms/${encodeURIComponent(conversationId)}/messages?after_seq=${afterSeq}&limit=${limit}`,
      );
      return data.messages;
    },
    thread: async (
      messageId: string,
    ): Promise<{ root: ClickClackMessage; replies: ClickClackMessage[] }> =>
      await request<{ root: ClickClackMessage; replies: ClickClackMessage[] }>(
        `/api/messages/${encodeURIComponent(messageId)}/thread`,
      ),
    createChannelMessage: async (channelId: string, body: string): Promise<ClickClackMessage> => {
      const data = await request<{ message: ClickClackMessage }>(
        `/api/channels/${encodeURIComponent(channelId)}/messages`,
        { method: "POST", body: JSON.stringify({ body }) },
      );
      return data.message;
    },
    createThreadReply: async (messageId: string, body: string): Promise<ClickClackMessage> => {
      const data = await request<{ message: ClickClackMessage }>(
        `/api/messages/${encodeURIComponent(messageId)}/thread/replies`,
        { method: "POST", body: JSON.stringify({ body }) },
      );
      return data.message;
    },
    createDirectConversation: async (
      workspaceId: string,
      memberIds: string[],
    ): Promise<{ id: string }> => {
      const data = await request<{ conversation: { id: string } }>("/api/dms", {
        method: "POST",
        body: JSON.stringify({ workspace_id: workspaceId, member_ids: memberIds }),
      });
      return data.conversation;
    },
    createDirectMessage: async (
      conversationId: string,
      body: string,
    ): Promise<ClickClackMessage> => {
      const data = await request<{ message: ClickClackMessage }>(
        `/api/dms/${encodeURIComponent(conversationId)}/messages`,
        { method: "POST", body: JSON.stringify({ body }) },
      );
      return data.message;
    },
    events: async (workspaceId: string, afterCursor?: string): Promise<ClickClackEvent[]> => {
      const query = new URLSearchParams({ workspace_id: workspaceId });
      if (afterCursor) {
        query.set("after_cursor", afterCursor);
      }
      const data = await request<{ events: ClickClackEvent[] }>(
        `/api/realtime/events?${query.toString()}`,
      );
      return data.events;
    },
    websocket: (workspaceId: string, afterCursor?: string): WebSocket => {
      const url = new URL(`${baseUrl}/api/realtime/ws`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("workspace_id", workspaceId);
      if (afterCursor) {
        url.searchParams.set("after_cursor", afterCursor);
      }
      return new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${options.token}`,
        },
      });
    },
  };
}

export type ClickClackClient = ReturnType<typeof createClickClackClient>;
