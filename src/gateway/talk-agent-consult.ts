// Gateway Talk realtime agent-consult bridge.
// Starts chat.send runs that answer realtime Talk tool calls.
import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeTalkSection } from "../config/talk.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  buildRealtimeVoiceAgentConsultChatMessage,
} from "../talk/agent-consult-tool.js";
import { abortChatRunById } from "./chat-abort.js";
import { handleTrustedInternalChatSend } from "./server-methods/chat-send-handler.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/shared-types.js";
import { resolveTalkAgentConsultAuthority } from "./talk-client-gateway-control.js";
import { registerTalkRealtimeRelayAgentRun } from "./talk-realtime-relay.js";
import type { PreparedTalkSessionTarget } from "./talk-session-target.types.js";
import { formatForLog } from "./ws-log.js";

type TalkChatSendAckStatus = "started" | "in_flight" | "ok" | "timeout" | "error";

function normalizeTalkChatSendAckStatus(result: unknown): TalkChatSendAckStatus {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "started";
  }
  const status = (result as Record<string, unknown>).status;
  return status === "in_flight" || status === "ok" || status === "timeout" || status === "error"
    ? status
    : "started";
}

function terminalTalkChatSendAckError(status: TalkChatSendAckStatus): ErrorShape | undefined {
  if (status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      "Realtime agent consult ended before the run started.",
    );
  }
  if (status === "error") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      "Realtime agent consult failed before the run started.",
    );
  }
  if (status === "ok") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      "Realtime agent consult completed before the tool result subscription started.",
    );
  }
  return undefined;
}

/**
 * Starts the agent-consult chat run that backs realtime Talk tool calls.
 */
export async function startTalkRealtimeAgentConsult(
  request: GatewayRequestHandlerOptions,
  params: {
    sessionTarget: PreparedTalkSessionTarget;
    callId: string;
    args: unknown;
    relaySessionId?: string;
    connId?: string;
    onRunStarted?: (runId: string) => void;
  },
): Promise<{ ok: true; runId: string; idempotencyKey: string } | { ok: false; error: ErrorShape }> {
  let message: string;
  try {
    message = buildRealtimeVoiceAgentConsultChatMessage(params.args);
  } catch (err) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)) };
  }
  const idempotencyKey = `talk-${params.callId}-${randomUUID()}`;
  const normalizedTalk = normalizeTalkSection(request.context.getRuntimeConfig().talk);
  const authority = resolveTalkAgentConsultAuthority(request.client?.connect?.scopes);
  let acknowledgedRunId: string | undefined;
  const chatResponse = await new Promise<
    { ok: true; result: unknown } | { ok: false; error: ErrorShape } | undefined
  >((resolve) => {
    let acknowledged = false;
    const chatSendOptions = {
      ...request,
      req: {
        type: "req",
        id: `${request.req.id}:talk-tool-call`,
        method: "chat.send",
      },
      params: {
        sessionKey: params.sessionTarget.canonicalKey,
        agentId: params.sessionTarget.agentId,
        message,
        idempotencyKey,
        suppressCommandInterpretation: true,
        systemInputProvenance: {
          kind: "internal_system",
          sourceTool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        },
        ...(normalizedTalk?.consultThinkingLevel
          ? { thinking: normalizedTalk.consultThinkingLevel }
          : {}),
        ...(typeof normalizedTalk?.consultFastMode === "boolean"
          ? { fastMode: normalizedTalk.consultFastMode }
          : {}),
      },
      respond: (ok: boolean, result?: unknown, error?: ErrorShape) => {
        acknowledged = true;
        if (ok && !terminalTalkChatSendAckError(normalizeTalkChatSendAckStatus(result))) {
          const candidateRunId =
            result && typeof result === "object" && !Array.isArray(result)
              ? (result as Record<string, unknown>).runId
              : undefined;
          const runId = typeof candidateRunId === "string" ? candidateRunId : idempotencyKey;
          try {
            if (params.relaySessionId && params.connId) {
              registerTalkRealtimeRelayAgentRun({
                relaySessionId: params.relaySessionId,
                connId: params.connId,
                sessionKey: params.sessionTarget.canonicalKey,
                runId,
                callId: params.callId,
              });
            }
            params.onRunStarted?.(runId);
            acknowledgedRunId = runId;
          } catch (registrationError) {
            abortChatRunById(request.context, {
              runId,
              sessionKey: params.sessionTarget.canonicalKey,
              stopReason: "voice session binding failed",
            });
            resolve({
              ok: false,
              error: errorShape(ErrorCodes.UNAVAILABLE, formatForLog(registrationError)),
            });
            return;
          }
        }
        resolve(
          ok
            ? { ok: true, result }
            : {
                ok: false,
                error:
                  error ?? errorShape(ErrorCodes.UNAVAILABLE, "chat.send failed without error"),
              },
        );
      },
    } satisfies GatewayRequestHandlerOptions;
    // Speech owns reusable history; keep consult scaffolding only in the lossless archive.
    const chatSendResult = handleTrustedInternalChatSend(chatSendOptions, undefined, {
      toolsAllow: authority.toolsAllow,
      transcript: { display: false, excludeFromContext: true },
    });
    void Promise.resolve(chatSendResult).then(
      () => {
        if (!acknowledged) {
          resolve(undefined);
        }
      },
      (error: unknown) => {
        if (acknowledged) {
          request.context.logGateway.warn(
            `realtime Talk agent consult failed after acknowledgement: ${formatForLog(error)}`,
          );
          return;
        }
        resolve({
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)),
        });
      },
    );
  });

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
  const terminalAckError = terminalTalkChatSendAckError(normalizeTalkChatSendAckStatus(result));
  if (terminalAckError) {
    return { ok: false, error: terminalAckError };
  }
  if (!acknowledgedRunId) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "chat.send did not acknowledge an active run"),
    };
  }
  return { ok: true, runId: acknowledgedRunId, idempotencyKey };
}
