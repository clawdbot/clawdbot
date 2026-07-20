import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";

type ChatSendAckStatus = "started" | "in_flight" | "ok" | "timeout" | "error";

export type ChatSendAckServerTiming = {
  receivedToAckMs?: number;
  loadSessionMs?: number;
  prepareAttachmentsMs?: number;
};

export type ChatSendAck = {
  runId: string;
  status: ChatSendAckStatus;
  serverTiming?: ChatSendAckServerTiming;
};

export type TerminalFailureChatSendAck = ChatSendAck & { status: "timeout" | "error" };

// ChatSendAck's status is a union field, not a discriminant across object
// types; callers need this predicate to narrow the whole ack object.
export function isTerminalFailureChatSendAck(
  ack: ChatSendAck | null,
): ack is TerminalFailureChatSendAck {
  return ack?.status === "timeout" || ack?.status === "error";
}

export type ChatSendTimingEntry = {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  sendAttempts: number;
  sendState?: ChatQueueItem["sendState"];
  submittedAtMs: number;
  requestStartedAtMs?: number;
  ackAtMs?: number;
  ackStatus?: ChatSendAckStatus;
  firstAssistantVisibleRecorded?: boolean;
};
