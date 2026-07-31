// Gateway RPC handlers for cooperative, host-neutral process suspension.
import {
  ErrorCodes,
  errorShape,
  validateGatewaySuspendPrepareParams,
  validateGatewaySuspendResumeParams,
  validateGatewaySuspendStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import { createGatewayServerActiveWorkInspectors } from "../server-active-work.js";
import type { GatewayRequestHandlers } from "./types.js";

function invalidParams(method: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params`);
}

function schedulerRecoveryError(retryAfterMs: number) {
  return errorShape(ErrorCodes.UNAVAILABLE, "gateway scheduler recovery is pending", {
    retryable: true,
    retryAfterMs,
    details: { reason: "scheduler-resume-failed" },
  });
}

export const suspendHandlers: GatewayRequestHandlers = {
  "gateway.suspend.prepare": async ({ respond, params, context }) => {
    if (!validateGatewaySuspendPrepareParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.prepare"));
      return;
    }
    const requestId = params.requestId.trim();
    const result = prepareGatewaySuspend({
      requestId,
      pauseScheduling: () => context.cron.pauseScheduling(),
      resumeScheduling: () => context.cron.resumeScheduling(),
      inspect: createGatewayServerActiveWorkInspectors(context),
      warn: (message) => context.logGateway.warn(message),
    });
    if (result.status === "conflict") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "another gateway suspension is already prepared", {
          retryable: true,
          retryAfterMs: Math.max(0, result.expiresAtMs - Date.now()),
          details: { reason: "gateway-suspension-conflict", expiresAtMs: result.expiresAtMs },
        }),
      );
      return;
    }
    if (result.status === "recovering") {
      respond(false, undefined, schedulerRecoveryError(result.retryAfterMs));
      return;
    }
    respond(true, result);
  },
  "gateway.suspend.status": async ({ respond, params }) => {
    if (!validateGatewaySuspendStatusParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.status"));
      return;
    }
    const suspensionId = params.suspensionId.trim();
    const result = getGatewaySuspendStatus(suspensionId);
    if (result.status === "conflict") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "a different gateway suspension is prepared", {
          retryable: true,
          retryAfterMs: Math.max(0, result.expiresAtMs - Date.now()),
          details: { reason: "gateway-suspension-conflict", expiresAtMs: result.expiresAtMs },
        }),
      );
      return;
    }
    if (result.status === "recovering") {
      respond(false, undefined, schedulerRecoveryError(result.retryAfterMs));
      return;
    }
    respond(true, result);
  },
  "gateway.suspend.resume": async ({ respond, params }) => {
    if (!validateGatewaySuspendResumeParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.resume"));
      return;
    }
    const suspensionId = params.suspensionId.trim();
    const result = resumeGatewaySuspend(suspensionId);
    if (!result.ok) {
      if (result.reason === "scheduler-resume-failed") {
        respond(false, undefined, schedulerRecoveryError(result.retryAfterMs));
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "gateway suspension id does not match"),
      );
      return;
    }
    respond(true, result);
  },
};
