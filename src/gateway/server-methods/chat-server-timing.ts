import { isOperatorUiClient } from "../../utils/message-channel.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type ChatSendAckServerTiming = {
  receivedToAckMs: number;
  loadSessionMs: number;
  prepareAttachmentsMs?: number;
};

export type ChatSendServerTimingPhase =
  | "dispatch-started"
  | "model-selected"
  | "agent-run-started"
  | "first-assistant-event"
  | "dispatch-completed"
  | "post-dispatch-completed";

export function roundedChatSendTimingMs(value: number): number {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

export function chatSendAckServerTimingAttributes(
  timing: ChatSendAckServerTiming | undefined,
): Record<string, number> {
  if (!timing) {
    return {};
  }
  return {
    serverReceivedToAckMs: timing.receivedToAckMs,
    serverLoadSessionMs: timing.loadSessionMs,
    ...(timing.prepareAttachmentsMs !== undefined
      ? { serverPrepareAttachmentsMs: timing.prepareAttachmentsMs }
      : {}),
  };
}

export function shouldIncludeChatSendAckServerTiming(client?: {
  id?: string | null;
  mode?: string | null;
}): boolean {
  return isOperatorUiClient(client);
}

const CONTROL_UI_RECONNECT_RESUME_PARAM = "__controlUiReconnectResume";

export function resolveControlUiReconnectResumeParams(
  params: unknown,
  clientInfo?: { id?: string | null; mode?: string | null },
): { params: unknown; resumeRequested: boolean } {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { params, resumeRequested: false };
  }
  const record = params as Record<string, unknown>;
  const resumeRequested =
    record[CONTROL_UI_RECONNECT_RESUME_PARAM] === true && isOperatorUiClient(clientInfo);
  if (!resumeRequested) {
    return { params, resumeRequested: false };
  }
  const validatedParams = { ...record };
  delete validatedParams[CONTROL_UI_RECONNECT_RESUME_PARAM];
  return { params: validatedParams, resumeRequested: true };
}

export function emitOperatorChatSendServerTiming(params: {
  context: Pick<GatewayRequestContext, "broadcastToConnIds">;
  client?: GatewayClient | null;
  phase: ChatSendServerTimingPhase;
  runId: string;
  sessionKey: string;
  agentId?: string;
  receivedAtMs: number;
  ackedAtMs: number;
  dispatchStartedAtMs?: number;
  extra?: Record<string, string | number>;
}) {
  const connId =
    typeof params.client?.connId === "string" && params.client.connId.trim()
      ? params.client.connId.trim()
      : undefined;
  if (!connId || !isOperatorUiClient(params.client?.connect?.client)) {
    return;
  }
  const nowMs = performance.now();
  params.context.broadcastToConnIds(
    "chat.send_timing",
    {
      phase: params.phase,
      runId: params.runId,
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ackToPhaseMs: roundedChatSendTimingMs(nowMs - params.ackedAtMs),
      receivedToPhaseMs: roundedChatSendTimingMs(nowMs - params.receivedAtMs),
      ...(params.dispatchStartedAtMs !== undefined
        ? {
            dispatchStartedToPhaseMs: roundedChatSendTimingMs(nowMs - params.dispatchStartedAtMs),
          }
        : {}),
      ...params.extra,
    },
    new Set([connId]),
    { dropIfSlow: true },
  );
}
