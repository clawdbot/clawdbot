import {
  ErrorCodes,
  errorShape,
  validateSessionsGoalClearParams,
  validateSessionsGoalUpdateParams,
  type SessionsGoalClearParams,
  type SessionsGoalUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  mutateSessionGoal,
  SessionGoalOperationError,
  type SessionGoalOperation,
} from "../../config/sessions/goals-operations.js";
import { recordSessionGoalChanged } from "../../sessions/session-state-events.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  resolveSessionMutationAuthorization,
  resolveSessionSharingTarget,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { fingerprintSessionGoalRequest } from "./session-goal-request.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

async function handleSessionGoalMutation(
  options: GatewayRequestHandlerOptions,
  request: SessionsGoalUpdateParams | (SessionsGoalClearParams & { action: "clear" }),
): Promise<void> {
  const { client, context, respond } = options;
  const method = request.action === "clear" ? "sessions.goal.clear" : "sessions.goal.update";
  try {
    const authorization = options.sessionMutationAuthorization
      ? { authorization: options.sessionMutationAuthorization, error: null }
      : resolveSessionMutationAuthorization({
          client,
          method,
          requestParams: request,
          context,
        });
    if (authorization.error) {
      respond(false, undefined, authorization.error);
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, request.sessionKey, request.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const target = resolveSessionSharingTarget({
      cfg,
      sessionKey: request.sessionKey,
      agentId: requestedAgent.agentId,
    });
    if (!target || (request.sessionId && target.entry.sessionId !== request.sessionId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Session changed or was removed; refresh its Goal."),
      );
      return;
    }
    const assertCurrent = () => {
      options.sessionMutationCommitGuard?.();
      authorization.authorization?.assertCurrent();
      const current = resolveSessionSharingTarget({
        cfg: context.getRuntimeConfig(),
        sessionKey: request.sessionKey,
        agentId: requestedAgent.agentId,
      });
      // Reset can keep the same session ID. Fence the lifecycle and resolved store as well.
      if (
        !current ||
        current.agentId !== target.agentId ||
        current.storePath !== target.storePath ||
        current.storeKey !== target.storeKey ||
        current.entry.sessionId !== target.entry.sessionId ||
        current.entry.lifecycleRevision !== target.entry.lifecycleRevision
      ) {
        throw new SessionMutationAuthorizationChangedError(
          errorShape(ErrorCodes.INVALID_REQUEST, "Session changed before its Goal update; retry."),
        );
      }
      const ownershipError = resolvePluginSessionOwnershipError({
        action: "patch",
        entry: current.entry,
        key: current.canonicalKey,
        pluginOwnerId: client?.internal?.pluginRuntimeOwnerId,
      });
      if (ownershipError) {
        throw new SessionMutationAuthorizationChangedError(ownershipError);
      }
    };
    assertCurrent();
    const identity = {
      operationId: request.operationId,
      issuedAtMs: request.issuedAtMs,
      requestFingerprint: fingerprintSessionGoalRequest({ method, ...request }),
      goalId: request.goalId,
    };
    if (request.action === "resume") {
      const { handleSessionGoalResumeChat } = await import("./chat-send-handler.js");
      await handleSessionGoalResumeChat(
        {
          ...options,
          sessionMutationAuthorization: {
            assertCurrent,
            assertTargetCurrent: assertCurrent,
          },
          params: {
            sessionKey: target.canonicalKey,
            agentId: target.agentId,
            sessionId: target.entry.sessionId,
            message: request.note
              ? `Continue pursuing the current goal.\nOperator note: ${request.note}`
              : "Continue pursuing the current goal.",
            idempotencyKey: request.operationId,
            deliver: false,
          },
        },
        { ...identity, action: "resume", ...(request.note ? { note: request.note } : {}) },
      );
      return;
    }
    const operation = (
      request.action === "edit"
        ? { ...identity, action: "edit", objective: request.objective }
        : {
            ...identity,
            action: request.action,
            ...("note" in request && request.note ? { note: request.note } : {}),
          }
    ) satisfies SessionGoalOperation;
    const committed = await mutateSessionGoal({
      agentId: target.agentId,
      sessionKey: target.storeKey,
      storePath: target.storePath,
      expectedSessionId: target.entry.sessionId,
      operation,
      assertCurrent,
    });
    if (!committed.replayed && committed.sessionEntry) {
      recordSessionGoalChanged({
        sessionKey: target.canonicalKey,
        agentId: target.agentId,
        entry: committed.sessionEntry,
        actor: gatewayClientSessionCreator(client),
        summary: `goal ${request.action}`,
      });
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        agentId: target.agentId,
        reason: "goal",
      });
    }
    respond(
      true,
      { ...committed.result, ...(committed.replayed ? { replayed: true } : {}) },
      undefined,
    );
  } catch (error) {
    if (error instanceof SessionMutationAuthorizationChangedError) {
      respond(false, undefined, error.error);
    } else if (error instanceof SessionGoalOperationError) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
          details: { code: "GOAL_OPERATION_REJECTED", reason: error.code },
        }),
      );
    } else {
      context.logGateway.warn(`Goal update failed: ${String(error)}`);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Unable to update the Goal; retry the request."),
      );
    }
  }
}

export const sessionGoalHandlers: GatewayRequestHandlers = {
  "sessions.goal.update": async (options) => {
    const { params, respond } = options;
    if (
      assertValidParams(params, validateSessionsGoalUpdateParams, "sessions.goal.update", respond)
    ) {
      await handleSessionGoalMutation(options, params);
    }
  },
  "sessions.goal.clear": async (options) => {
    const { params, respond } = options;
    if (
      assertValidParams(params, validateSessionsGoalClearParams, "sessions.goal.clear", respond)
    ) {
      await handleSessionGoalMutation(options, { ...params, action: "clear" });
    }
  },
};
