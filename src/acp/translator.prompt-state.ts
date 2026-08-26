import type { PromptResponse, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";

export type AcpDisconnectContext = {
  generation: number;
  reason: string;
};

export type AcpPendingPrompt = {
  sessionId: string;
  sessionKey: string;
  ledgerSessionId?: string;
  idempotencyKey: string;
  sendAccepted?: boolean;
  disconnectContext?: AcpDisconnectContext;
  resolve: (response: PromptResponse) => void;
  reject: (err: Error) => void;
  sentTextLength?: number;
  sentText?: string;
  sentThoughtLength?: number;
  sentThought?: string;
  toolCalls?: Map<string, AcpPendingToolCall>;
};

export type AcpPendingApprovalRelay = {
  approvalId: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
  state: "active" | "completed";
};

type AcpPendingToolCall = {
  kind: ToolKind;
  locations?: ToolCallLocation[];
  rawInput?: Record<string, unknown>;
  title: string;
};

export type AcpAgentWaitResult = {
  status?: "ok" | "error" | "timeout";
  error?: string;
};
