import type { McpServer } from "@modelcontextprotocol/server";
// Channel MCP tools expose channel operations through an MCP server.
import { z } from "zod";
import type { OpenClawChannelBridge } from "./channel-bridge.js";
import {
  extractAttachmentsFromMessage,
  summarizeResult,
  summarizeStructuredResult,
  toText,
} from "./channel-shared.js";

/**
 * MCP tool registration for channel conversation access.
 *
 * Tool handlers stay thin: schemas validate public inputs and the bridge owns
 * Gateway readiness, routing, event queueing, and approval resolution.
 */
/** Return protocol capabilities advertised when Claude channel mode is enabled. */
export function getChannelMcpCapabilities(claudeChannelMode: "off" | "on" | "auto") {
  if (claudeChannelMode === "off") {
    return undefined;
  }
  return {
    experimental: {
      "claude/channel": {},
      "claude/channel/permission": {},
    },
  };
}

/** Register all channel MCP tools against a server instance. */
export function registerChannelMcpTools(server: McpServer, bridge: OpenClawChannelBridge): void {
  server.registerTool(
    "conversations_list",
    {
      description: "List OpenClaw channel-backed conversations available through session routes.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).optional(),
        search: z.string().optional(),
        channel: z.string().optional(),
        includeDerivedTitles: z.boolean().optional(),
        includeLastMessage: z.boolean().optional(),
      }),
    },
    async (args) => {
      const conversations = await bridge.listConversations(args);
      return {
        ...summarizeStructuredResult("conversations", conversations.length, { conversations }),
        structuredContent: { conversations },
      };
    },
  );

  server.registerTool(
    "conversation_get",
    {
      description: "Get one OpenClaw conversation by session key.",
      inputSchema: z.object({ session_key: z.string().min(1) }),
    },
    async ({ session_key }) => {
      const conversation = await bridge.getConversation(session_key);
      if (!conversation) {
        return {
          content: [{ type: "text", text: `conversation not found: ${session_key}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `conversation ${conversation.sessionKey}` }],
        structuredContent: { conversation },
      };
    },
  );

  server.registerTool(
    "messages_read",
    {
      description: "Read recent messages for one OpenClaw conversation.",
      inputSchema: z.object({
        session_key: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    },
    async ({ session_key, limit }) => {
      const messages = await bridge.readMessages(session_key, limit ?? 20);
      return {
        ...summarizeStructuredResult("messages", messages.length, { messages }),
        structuredContent: { messages },
      };
    },
  );

  server.registerTool(
    "attachments_fetch",
    {
      description: "List non-text attachments for a message in one OpenClaw conversation.",
      inputSchema: z.object({
        session_key: z.string().min(1),
        message_id: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    },
    async ({ session_key, message_id, limit }) => {
      const message = await bridge.readMessage(session_key, message_id, limit ?? 100);
      if (!message) {
        return {
          content: [{ type: "text", text: `message not found: ${message_id}` }],
          isError: true,
        };
      }
      const attachments = extractAttachmentsFromMessage(message);
      return {
        ...summarizeResult("attachments", attachments.length),
        structuredContent: { attachments, message },
      };
    },
  );

  server.registerTool(
    "events_poll",
    {
      description: "Poll queued OpenClaw conversation events since a cursor.",
      inputSchema: z.object({
        after_cursor: z.number().int().min(0).optional(),
        session_key: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    },
    async ({ after_cursor, session_key, limit }) => {
      const { events, nextCursor, gap } = bridge.pollEvents(
        { afterCursor: after_cursor ?? 0, sessionKey: toText(session_key) },
        limit ?? 20,
      );
      return {
        ...summarizeResult("events", events.length),
        structuredContent: {
          events,
          next_cursor: nextCursor,
          ...(gap ? { gap } : {}),
        },
      };
    },
  );

  server.registerTool(
    "events_wait",
    {
      description: "Wait for the next queued OpenClaw conversation event.",
      inputSchema: z.object({
        after_cursor: z.number().int().min(0).optional(),
        session_key: z.string().optional(),
        timeout_ms: z.number().int().min(1).max(300_000).optional(),
      }),
    },
    async ({ after_cursor, session_key, timeout_ms }, extra) => {
      const { event, gap } = await bridge.waitForEvent(
        { afterCursor: after_cursor ?? 0, sessionKey: toText(session_key) },
        timeout_ms ?? 30_000,
        extra.mcpReq.signal,
      );
      return {
        content: [
          {
            type: "text",
            text: event
              ? `event ${event.cursor}`
              : gap
                ? `event gap before ${gap.oldest_available_cursor}`
                : "timeout",
          },
        ],
        structuredContent: { event, ...(gap ? { gap } : {}) },
      };
    },
  );

  server.registerTool(
    "messages_send",
    {
      description: "Send a message back through the same OpenClaw conversation route.",
      inputSchema: z.object({
        session_key: z.string().min(1),
        text: z.string().min(1),
      }),
    },
    async ({ session_key, text }) => {
      const result = await bridge.sendMessage({ sessionKey: session_key, text });
      return {
        content: [{ type: "text", text: "sent" }],
        structuredContent: { result },
      };
    },
  );

  server.registerTool(
    "permissions_list_open",
    {
      description:
        "List open OpenClaw exec or plugin approval requests visible through the Gateway.",
      inputSchema: z.object({}),
    },
    async () => {
      const approvals = bridge.listPendingApprovals();
      return {
        ...summarizeResult("approvals", approvals.length),
        structuredContent: { approvals },
      };
    },
  );

  server.registerTool(
    "permissions_respond",
    {
      description: "Allow or deny one pending OpenClaw exec or plugin approval request.",
      inputSchema: z.object({
        kind: z.enum(["exec", "plugin"]),
        id: z.string().min(1),
        decision: z.enum(["allow-once", "allow-always", "deny"]),
      }),
    },
    async ({ kind, id, decision }) => {
      const result = await bridge.respondToApproval({ kind, id, decision });
      return {
        content: [{ type: "text", text: "approval resolved" }],
        structuredContent: { result },
      };
    },
  );
}
