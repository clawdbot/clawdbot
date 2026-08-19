// Voice Call plugin module implements gateway continue operation behavior.
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { VoiceCallConfig } from "./config.js";
import type { VoiceCallRuntime } from "./runtime.js";
import { TELEPHONY_DEFAULT_TTS_TIMEOUT_MS } from "./telephony-tts.js";

// Async operation store for gateway continue-call requests that outlive one HTTP response.

const VOICE_CALL_CONTINUE_OPERATION_BUFFER_MS = 30000;
const VOICE_CALL_CONTINUE_OPERATION_CLEANUP_MS = 5 * 60 * 1000;

/** Internal lifecycle state for one continue-call operation. */
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

/** Payload returned immediately when a continue operation starts. */
type VoiceCallContinueOperationStartPayload = {
  operationId: string;
  status: "pending";
  pollTimeoutMs: number;
};

/** Payload returned while polling a continue operation. */
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

/** Request needed to start a continue-call operation. */
type VoiceCallContinueOperationRequest = {
  rt: VoiceCallRuntime;
  callId: string;
  run: () => Promise<{ success: true; transcript?: string }>;
};

/** Create a process-local operation store for gateway continue-call polling. */
export function createVoiceCallContinueOperationStore(params: {
  config: VoiceCallConfig;
  coreConfig: OpenClawConfig;
}) {
  const operations = new Map<string, VoiceCallContinueOperation>();

  const resolvePollTimeoutMs = (rt: VoiceCallRuntime): number => {
    const ttsTimeoutMs =
      rt.config.tts?.timeoutMs ??
      params.config.tts?.timeoutMs ??
      params.coreConfig.tts?.timeoutMs ??
      TELEPHONY_DEFAULT_TTS_TIMEOUT_MS;
    return resolveTimerTimeoutMs(
      (rt.config.transcriptTimeoutMs ?? params.config.transcriptTimeoutMs) +
        ttsTimeoutMs +
        VOICE_CALL_CONTINUE_OPERATION_BUFFER_MS,
      VOICE_CALL_CONTINUE_OPERATION_BUFFER_MS,
    );
  };

  const scheduleCleanup = (operationId: string) => {
    const timer = setTimeout(() => {
      operations.delete(operationId);
    }, VOICE_CALL_CONTINUE_OPERATION_CLEANUP_MS);
    timer.unref?.();
  };

  // continueCall can wait for speech/TTS/transcript work; callers poll this in the meantime.
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

    void request
      .run()
      .then((result) => {
        const current = operations.get(operationId);
        if (!current || current.status !== "pending") {
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
      .catch((err: unknown) => {
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
