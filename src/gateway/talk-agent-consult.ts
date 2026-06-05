// Gateway Talk realtime agent-consult bridge.
// Starts chat.send runs that answer realtime Talk tool calls.
import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type ConnectParams,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeTalkSection } from "../config/talk.js";
import { buildRealtimeVoiceAgentConsultChatMessage } from "../talk/agent-consult-tool.js";
import { chatHandlers } from "./server-methods/chat.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
} from "./server-methods/shared-types.js";
import { registerTalkRealtimeRelayAgentRun } from "./talk-realtime-relay.js";
import { formatForLog } from "./ws-log.js";

/**
 * Starts the agent-consult chat run that backs realtime Talk tool calls.
 */
export async function startTalkRealtimeAgentConsult(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  requestId: string;
  sessionKey: string;
  callId: string;
  args: unknown;
  relaySessionId?: string;
  connId?: string;
}): Promise<
  { ok: true; runId: string; idempotencyKey: string } | { ok: false; error: ErrorShape }
> {
  let message: string;
  try {
    message = buildRealtimeVoiceAgentConsultChatMessage(params.args);
  } catch (err) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)) };
  }
  const idempotencyKey = `talk-${params.callId}-${randomUUID()}`;
  const normalizedTalk = normalizeTalkSection(params.context.getRuntimeConfig().talk);
  let chatResponse: { ok: true; result: unknown } | { ok: false; error: ErrorShape } | undefined;
  await chatHandlers["chat.send"]({
    req: {
      type: "req",
      id: `${params.requestId}:talk-tool-call`,
      method: "chat.send",
    },
    client: params.client,
    isWebchatConnect: params.isWebchatConnect,
    context: params.context,
    params: {
      sessionKey: params.sessionKey,
      message,
      idempotencyKey,
      ...(normalizedTalk?.consultThinkingLevel
        ? { thinking: normalizedTalk.consultThinkingLevel }
        : {}),
      ...(typeof normalizedTalk?.consultFastMode === "boolean"
        ? { fastMode: normalizedTalk.consultFastMode }
        : {}),
    },
    respond: (ok: boolean, result?: unknown, error?: ErrorShape) => {
      chatResponse = ok
        ? { ok: true, result }
        : {
            ok: false,
            error: error ?? errorShape(ErrorCodes.UNAVAILABLE, "chat.send failed without error"),
          };
    },
  } as Parameters<GatewayRequestHandlers[string]>[0]);

  if (!chatResponse) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "chat.send did not return a realtime tool result"),
    };
  }
  if (!chatResponse.ok) {
    return { ok: false, error: chatResponse.error };
  }
  const result = chatResponse.result;
  const runId =
    result && typeof result === "object" && !Array.isArray(result)
      ? typeof (result as Record<string, unknown>).runId === "string"
        ? (result as Record<string, string>).runId
        : idempotencyKey
      : idempotencyKey;
  if (params.relaySessionId && params.connId) {
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: params.relaySessionId,
      connId: params.connId,
      sessionKey: params.sessionKey,
      runId,
      callId: params.callId,
    });
  }
  return { ok: true, runId, idempotencyKey };
}
