/**
 * Thin ClickClack REST/websocket client used by gateway, resolver, and outbound
 * delivery code.
 */
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { WebSocket } from "ws";
import type {
  ClickClackChannel,
  ClickClackEvent,
  ClickClackMessage,
  ClickClackMessageProvenance,
  ClickClackUser,
  ClickClackWorkspace,
} from "./types.js";

/**
 * Serializes optional provenance into the wire fields. Unknown JSON fields
 * are ignored by servers without the provenance columns, so these are safe
 * to send unconditionally when present.
 */
function provenanceFields(provenance?: ClickClackMessageProvenance): Record<string, string> {
  const fields: Record<string, string> = {};
  if (provenance?.model?.trim()) {
    fields.author_model = provenance.model.trim();
  }
  if (provenance?.thinking?.trim()) {
    fields.author_thinking = provenance.thinking.trim();
  }
  if (provenance?.runtime?.trim()) {
    fields.author_runtime = provenance.runtime.trim();
  }
  return fields;
}

type ClientOptions = {
  baseUrl: string;
  token: string;
  correlationId?: string;
  fetch?: typeof fetch;
};

const CLICKCLACK_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const CLICKCLACK_CORRELATION_ID_MAX_LENGTH = 128;
const CLICKCLACK_CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const CLICKCLACK_CORRELATION_ID_HEADER = "X-Correlation-ID";
// Keep REST and websocket JSON under the same bounded response budget. ClickClack
// accepts 1 MiB request bodies, then wraps and re-encodes them as events, so a
// valid frame can exceed 1 MiB before ws hands it to the event parser.
const CLICKCLACK_INBOUND_JSON_LIMIT_BYTES = 16 * 1024 * 1024;

/** Accepts the same bounded request-correlation shape as the ClickClack API. */
export function normalizeClickClackCorrelationId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > CLICKCLACK_CORRELATION_ID_MAX_LENGTH ||
    !CLICKCLACK_CORRELATION_ID_PATTERN.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

/**
 * Creates a typed client for the ClickClack API using bearer-token auth.
 */
export function createClickClackClient(options: ClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetcher = options.fetch ?? fetch;
  const correlationId = normalizeClickClackCorrelationId(options.correlationId);
  const headers = {
    Authorization: `Bearer ${options.token}`,
    Accept: "application/json",
  };

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const requestHeaders = new Headers(init.headers);
    for (const [key, value] of Object.entries(headers)) {
      requestHeaders.set(key, value);
    }
    if (correlationId) {
      requestHeaders.set(CLICKCLACK_CORRELATION_ID_HEADER, correlationId);
    }
    if (init.body && !(init.body instanceof FormData)) {
      requestHeaders.set("Content-Type", "application/json");
    }
    const response = await fetcher(`${baseUrl}${path}`, { ...init, headers: requestHeaders });
    if (!response.ok) {
      const detail = await readResponseTextLimited(response, CLICKCLACK_ERROR_BODY_LIMIT_BYTES);
      throw new Error(`ClickClack ${response.status}: ${detail}`);
    }
    return await readProviderJsonResponse<T>(response, "ClickClack response", {
      maxBytes: CLICKCLACK_INBOUND_JSON_LIMIT_BYTES,
    });
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
    createChannelMessage: async (
      channelId: string,
      body: string,
      opts?: { provenance?: ClickClackMessageProvenance; quotedMessageId?: string },
    ): Promise<ClickClackMessage> => {
      const data = await request<{ message: ClickClackMessage }>(
        `/api/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            body,
            ...(opts?.quotedMessageId ? { quoted_message_id: opts.quotedMessageId } : {}),
            ...provenanceFields(opts?.provenance),
          }),
        },
      );
      return data.message;
    },
    createThreadReply: async (
      messageId: string,
      body: string,
      opts?: { provenance?: ClickClackMessageProvenance },
    ): Promise<ClickClackMessage> => {
      const data = await request<{ message: ClickClackMessage }>(
        `/api/messages/${encodeURIComponent(messageId)}/thread/replies`,
        { method: "POST", body: JSON.stringify({ body, ...provenanceFields(opts?.provenance) }) },
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
    /**
     * POSTs a durable agent activity row (agent_commentary / agent_tool)
     * through the normal message create path. Requires a bot token carrying
     * the agent_activity:write scope on the ClickClack side.
     */
    createActivityMessage: async (params: {
      channelId?: string;
      conversationId?: string;
      body: string;
      kind: "agent_commentary" | "agent_tool";
      turnId?: string;
      provenance?: ClickClackMessageProvenance;
    }): Promise<ClickClackMessage> => {
      if (!params.channelId && !params.conversationId) {
        throw new Error("createActivityMessage requires a channelId or conversationId");
      }
      const path = params.channelId
        ? `/api/channels/${encodeURIComponent(params.channelId)}/messages`
        : `/api/dms/${encodeURIComponent(params.conversationId ?? "")}/messages`;
      const data = await request<{ message: ClickClackMessage }>(path, {
        method: "POST",
        body: JSON.stringify({
          body: params.body,
          kind: params.kind,
          turn_id: params.turnId,
          ...provenanceFields(params.provenance),
        }),
      });
      return data.message;
    },
    /** PATCHes the body of an existing message (activity row coalescing). */
    updateMessageBody: async (messageId: string, body: string): Promise<ClickClackMessage> => {
      const data = await request<{ message: ClickClackMessage }>(
        `/api/messages/${encodeURIComponent(messageId)}`,
        { method: "PATCH", body: JSON.stringify({ body }) },
      );
      return data.message;
    },
    createDirectMessage: async (
      conversationId: string,
      body: string,
      opts?: { quotedMessageId?: string },
    ): Promise<ClickClackMessage> => {
      const data = await request<{ message: ClickClackMessage }>(
        `/api/dms/${encodeURIComponent(conversationId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            body,
            ...(opts?.quotedMessageId ? { quoted_message_id: opts.quotedMessageId } : {}),
          }),
        },
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
        maxPayload: CLICKCLACK_INBOUND_JSON_LIMIT_BYTES,
      });
    },
  };
}

/** Client shape returned by `createClickClackClient`. */
export type ClickClackClient = ReturnType<typeof createClickClackClient>;
