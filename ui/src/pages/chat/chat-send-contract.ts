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
