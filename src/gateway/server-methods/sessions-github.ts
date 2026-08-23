import {
  ErrorCodes,
  errorShape,
  validateSessionGitHubPublishParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionsGitHubHandlers: GatewayRequestHandlers = {
  "sessions.github.publish": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (
      !assertValidParams(
        params,
        validateSessionGitHubPublishParams,
        "sessions.github.publish",
        respond,
      )
    ) {
      return;
    }
    const coordinator = context.githubPublicationService;
    if (!coordinator) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "GitHub publication is unavailable on this Gateway"),
      );
      return;
    }
    const caller = getGatewayToolCallerIdentity();
    const sessionKey = caller?.sessionKey ?? params.sessionKey;
    if (!sessionKey || (caller && params.sessionKey && params.sessionKey !== caller.sessionKey)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "GitHub publication session is invalid"),
      );
      return;
    }
    const loaded = loadGatewaySessionEntryReadOnly(
      sessionKey,
      caller?.agentId ? { agentId: caller.agentId } : undefined,
    );
    if (!loaded.entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "GitHub publication session was not found"),
      );
      return;
    }
    try {
      sessionMutationAuthorization?.assertCurrent();
      const result = await coordinator.requestForSession({
        ...params,
        sessionKey: loaded.canonicalKey,
        agentId: caller?.agentId ?? loaded.agentId,
        ...(caller?.operationalRunInstance?.runId
          ? { expectedRunId: caller.operationalRunInstance.runId }
          : {}),
        ...(sessionMutationAuthorization
          ? { assertCurrent: sessionMutationAuthorization.assertCurrent }
          : {}),
      });
      sessionMutationAuthorization?.assertCurrent();
      respond(true, result);
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : "GitHub publication request failed",
        ),
      );
    }
  },
};
