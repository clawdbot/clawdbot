import { z } from "zod";
import { normalizeOptionalString as toText } from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

export type ClaudeChannelMode = "off" | "on" | "auto";

export type ConversationDescriptor = {
  sessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number | null;
};

type SessionRow = {
  key: string;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number | null;
};

export type SessionListResult = {
  sessions?: SessionRow[];
};

export type SessionDescribeResult = {
  session?: SessionRow | null;
};

export type ChatHistoryResult = {
  messages?: Array<{ id?: string; role?: string; content?: unknown; [key: string]: unknown }>;
};

export type SessionMessagePayload = {
  sessionKey?: string;
  messageId?: string;
  messageSeq?: number;
  message?: { role?: string; content?: unknown; [key: string]: unknown };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  [key: string]: unknown;
};

export type ApprovalKind = "exec" | "plugin";
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export type PendingApproval = {
  kind: ApprovalKind;
  id: string;
  request?: Record<string, unknown>;
  createdAtMs?: number;
  expiresAtMs?: number;
};

export type QueueEvent =
  | {
      cursor: number;
      type: "message";
      sessionKey: string;
      conversation?: ConversationDescriptor;
      messageId?: string;
      messageSeq?: number;
      role?: string;
      text?: string;
      raw: SessionMessagePayload;
    }
  | {
      cursor: number;
      type: "claude_permission_request";
      requestId: string;
      toolName: string;
      description: string;
      inputPreview: string;
    }
  | {
      cursor: number;
      type: "exec_approval_requested" | "exec_approval_resolved";
      raw: Record<string, unknown>;
    }
  | {
      cursor: number;
      type: "plugin_approval_requested" | "plugin_approval_resolved";
      raw: Record<string, unknown>;
    };

export type ClaudePermissionRequest = {
  toolName: string;
  description: string;
  inputPreview: string;
};

export type WaitFilter = {
  afterCursor: number;
  sessionKey?: string;
};

export const ClaudePermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

export { toText };

export function resolveMessageId(entry: Record<string, unknown>): string | undefined {
  return (
    toText(entry.id) ??
    (entry.__openclaw && typeof entry.__openclaw === "object"
      ? toText((entry.__openclaw as { id?: unknown }).id)
      : undefined)
  );
}

export function summarizeResult(
  label: string,
  count: number,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: `${label}: ${count}` }],
  };
}

export function summarizeStructuredResult(
  label: string,
  count: number,
  payload: unknown,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: `${label}: ${count}\n\n${JSON.stringify(payload, null, 2)}` }],
  };
}

function resolveConversationChannel(row: SessionRow): string | undefined {
  return normalizeMessageChannel(
    toText(row.deliveryContext?.channel) ??
      toText(row.lastChannel) ??
      toText(row.channel) ??
      toText(row.origin?.provider),
  );
}

export function toConversation(row: SessionRow): ConversationDescriptor | null {
  const channel = resolveConversationChannel(row);
  const to = toText(row.deliveryContext?.to) ?? toText(row.lastTo);
  if (!channel || !to) {
    return null;
  }
  return {
    sessionKey: row.key,
    channel,
    to,
    accountId:
      toText(row.deliveryContext?.accountId) ??
      toText(row.lastAccountId) ??
      toText(row.origin?.accountId),
    threadId: row.deliveryContext?.threadId ?? row.lastThreadId ?? row.origin?.threadId,
    label: toText(row.label),
    displayName: toText(row.displayName),
    derivedTitle: toText(row.derivedTitle),
    lastMessagePreview: toText(row.lastMessagePreview),
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
  };
}

export function matchEventFilter(event: QueueEvent, filter: WaitFilter): boolean {
  if (event.cursor <= filter.afterCursor) {
    return false;
  }
  if (!filter.sessionKey) {
    return true;
  }
  return "sessionKey" in event && event.sessionKey === filter.sessionKey;
}

export function extractAttachmentsFromMessage(message: unknown): unknown[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    return toText((entry as { type?: unknown }).type) !== "text";
  });
}

export function normalizeApprovalId(value: unknown): string | undefined {
  const id = toText(value);
  return id ? id.trim() : undefined;
}
