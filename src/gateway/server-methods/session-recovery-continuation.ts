import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import type { SessionRecoveryContinuationOutcome } from "../session-recovery-service.js";
import { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const RECOVERY_CONTINUATION_TEXT =
  "Continue from the recovered transcript and finish the interrupted work.";

/** Starts the fixed recovery continuation as trusted system input. */
export async function launchSessionRecoveryContinuation(params: {
  agentId: string;
  client: GatewayRequestHandlerOptions["client"];
  commitGuard?: () => void;
  context: GatewayRequestHandlerOptions["context"];
  idempotencyKey: string;
  req: GatewayRequestHandlerOptions["req"];
  sessionId: string;
  sessionKey: string;
}): Promise<SessionRecoveryContinuationOutcome> {
  let outcome: SessionRecoveryContinuationOutcome | undefined;
  try {
    await handleTrustedInternalChatSend(
      {
        req: params.req,
        params: {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          sessionId: params.sessionId,
          message: formatSystemTurnPrompt(RECOVERY_CONTINUATION_TEXT),
          idempotencyKey: params.idempotencyKey,
          deliver: false,
          suppressCommandInterpretation: true,
          systemInputProvenance: {
            kind: "internal_system",
            sourceSessionKey: params.sessionKey,
            sourceTool: "sessions.recover",
          },
        },
        respond: (ok, payload, error) => {
          const response = payload as { runId?: unknown } | undefined;
          const runId =
            ok && response && typeof response.runId === "string" ? response.runId.trim() : "";
          outcome =
            ok && runId
              ? { status: "started", runId }
              : {
                  status: "rejected",
                  error:
                    error ?? errorShape(ErrorCodes.UNAVAILABLE, "Continuation was not started."),
                };
        },
        context: params.context,
        client: params.client,
        isWebchatConnect: () => false,
      },
      params.commitGuard
        ? async () => {
            params.commitGuard?.();
            return true;
          }
        : undefined,
    );
  } catch (error) {
    outcome = {
      status: "rejected",
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        error instanceof Error ? error.message : "Continuation authority check failed.",
      ),
    };
  }
  return (
    outcome ?? {
      status: "rejected",
      error: errorShape(ErrorCodes.UNAVAILABLE, "Continuation returned no outcome."),
    }
  );
}
