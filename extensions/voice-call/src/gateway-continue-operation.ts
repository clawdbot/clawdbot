import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import type { VoiceCallRuntime } from "./runtime.js";
import { TELEPHONY_DEFAULT_TTS_TIMEOUT_MS } from "./telephony-tts.js";

const VOICE_CALL_CONTINUE_OPERATION_BUFFER_MS = 30000;
const VOICE_CALL_CONTINUE_OPERATION_CLEANUP_MS = 5 * 60 * 1000;

type VoiceCallContinueOperation =
  | {
      operationId: string;
      status: "pending";
      callId: string;
      startedAtMs: number;
      pollTimeoutMs: number;
    }
  | {
      operationId: string;
      status: "completed";
      callId: string;
      startedAtMs: number;
      completedAtMs: number;
      pollTimeoutMs: number;
      result: { success: true; transcript?: string };
    }
  | {
      operationId: string;
      status: "failed";
      callId: string;
      startedAtMs: number;
      completedAtMs: number;
      pollTimeoutMs: number;
      error: string;
    };

type VoiceCallContinueOperationStartPayload = {
  operationId: string;
  status: "pending";
  pollTimeoutMs: number;
};

type VoiceCallContinueOperationResultPayload =
  | {
      operationId: string;
      status: "pending";
      pollTimeoutMs: number;
    }
  | {
      operationId: string;
      status: "completed";
      result: { success: true; transcript?: string };
    }
  | {
      operationId: string;
      status: "failed";
      error: string;
    };

type VoiceCallContinueOperationRequest = {
  rt: VoiceCallRuntime;
  callId: string;
  message: string;
};

export function createVoiceCallContinueOperationStore(params: {
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
}) {
  const operations = new Map<string, VoiceCallContinueOperation>();

  const resolvePollTimeoutMs = (rt: VoiceCallRuntime): number => {
    const ttsTimeoutMs =
      rt.config.tts?.timeoutMs ??
      params.config.tts?.timeoutMs ??
      params.coreConfig.messages?.tts?.timeoutMs ??
      TELEPHONY_DEFAULT_TTS_TIMEOUT_MS;
    return (
      (rt.config.transcriptTimeoutMs ?? params.config.transcriptTimeoutMs) +
      ttsTimeoutMs +
      VOICE_CALL_CONTINUE_OPERATION_BUFFER_MS
    );
  };

  const scheduleCleanup = (operationId: string) => {
    const timer = setTimeout(() => {
      operations.delete(operationId);
    }, VOICE_CALL_CONTINUE_OPERATION_CLEANUP_MS);
    timer.unref?.();
  };

  const start = (
    request: VoiceCallContinueOperationRequest,
  ): VoiceCallContinueOperationStartPayload => {
    const operationId = randomUUID();
    const startedAtMs = Date.now();
    const pollTimeoutMs = resolvePollTimeoutMs(request.rt);
    operations.set(operationId, {
      operationId,
      status: "pending",
      callId: request.callId,
      startedAtMs,
      pollTimeoutMs,
    });

    void request.rt.manager
      .continueCall(request.callId, request.message)
      .then((result) => {
        const current = operations.get(operationId);
        if (!current || current.status !== "pending") {
          return;
        }
        if (!result.success) {
          operations.set(operationId, {
            operationId,
            status: "failed",
            callId: request.callId,
            startedAtMs,
            completedAtMs: Date.now(),
            pollTimeoutMs,
            error: result.error || "continue failed",
          });
          return;
        }
        operations.set(operationId, {
          operationId,
          status: "completed",
          callId: request.callId,
          startedAtMs,
          completedAtMs: Date.now(),
          pollTimeoutMs,
          result: { success: true, transcript: result.transcript },
        });
      })
      .catch((err) => {
        const current = operations.get(operationId);
        if (!current || current.status !== "pending") {
          return;
        }
        operations.set(operationId, {
          operationId,
          status: "failed",
          callId: request.callId,
          startedAtMs,
          completedAtMs: Date.now(),
          pollTimeoutMs,
          error: formatErrorMessage(err),
        });
      })
      .finally(() => {
        scheduleCleanup(operationId);
      });

    return { operationId, status: "pending", pollTimeoutMs };
  };

  const read = (
    operationId: string,
  ):
    | { ok: true; payload: VoiceCallContinueOperationResultPayload }
    | { ok: false; error: string } => {
    const operation = operations.get(operationId);
    if (!operation) {
      return { ok: false, error: "operation not found" };
    }
    if (operation.status === "pending") {
      return {
        ok: true,
        payload: {
          operationId,
          status: "pending",
          pollTimeoutMs: operation.pollTimeoutMs,
        },
      };
    }
    if (operation.status === "failed") {
      operations.delete(operationId);
      return {
        ok: true,
        payload: {
          operationId,
          status: "failed",
          error: operation.error,
        },
      };
    }
    operations.delete(operationId);
    return {
      ok: true,
      payload: {
        operationId,
        status: "completed",
        result: operation.result,
      },
    };
  };

  return { start, read };
}
