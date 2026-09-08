import {
  ErrorCodes,
  type GatewayCoreRequestParams,
  errorShape,
  validateSessionGitHubPublishParams,
  validateSessionGitHubOptionsParams,
  validateSessionGitHubStatusParams,
  validateSessionGitHubConfirmParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { prepareCurrentGitHubPublicationIdentity } from "../github-publication-availability.js";
import { GitHubPublicationKnownFailure } from "../github-publication-failure.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import {
  preparePersonalGitHubAction,
  prepareGitHubPublicationOptionsRead,
  preparePersonalGitHubSessionAction,
} from "./github-personal-authorization.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type SessionGitHubMethod = Extract<keyof GatewayCoreRequestParams, `sessions.github.${string}`>;
const sessionGitHubFailureMessages = {
  "sessions.github.publish": "GitHub publication request failed",
  "sessions.github.options": "GitHub publication options are unavailable.",
  "sessions.github.status": "GitHub publication status is unavailable.",
  "sessions.github.confirm": "GitHub publication confirmation failed.",
};

function defineSessionGitHubMethod<Method extends SessionGitHubMethod>(
  ...[method, validate, handler]: Parameters<typeof defineValidatedGatewayMethod<Method>>
) {
  return defineValidatedGatewayMethod(method, validate, async (options) => {
    const { agentId, sessionKey } = options.params;
    const key = sessionKey ?? getGatewayToolCallerIdentity()?.sessionKey;
    // Explicit public owners follow request admission, not private deleted-session remapping.
    if (agentId !== undefined && key) {
      const owner = resolveRequestedSessionAgentId(
        options.context.getRuntimeConfig(),
        key,
        agentId,
      );
      if (!owner.ok) {
        options.respond(false, undefined, owner.error);
        return;
      }
    }
    try {
      return await handler(options);
    } catch (error) {
      const publishing = method === "sessions.github.publish";
      if (publishing && error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      options.respond(
        false,
        undefined,
        errorShape(
          publishing ? ErrorCodes.UNAVAILABLE : ErrorCodes.FORBIDDEN,
          error instanceof Error ? error.message : sessionGitHubFailureMessages[method],
          publishing &&
            error instanceof GitHubPublicationKnownFailure &&
            "idempotencyKey" in options.params &&
            error.rejection?.idempotencyKey === options.params.idempotencyKey
            ? { details: error.rejection }
            : undefined,
        ),
      );
    }
  });
}

export const sessionsGitHubHandlers: GatewayRequestHandlers = {
  "sessions.github.publish": defineSessionGitHubMethod(
    "sessions.github.publish",
    validateSessionGitHubPublishParams,
    async (options) => {
      const { params, respond, context, sessionMutationAuthorization } = options;

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
      if (
        !sessionKey ||
        (caller && params.sessionKey && params.sessionKey !== caller.sessionKey) ||
        (caller &&
          params.agentId &&
          normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId))
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "GitHub publication session is invalid"),
        );
        return;
      }
      const agentId = caller?.agentId ?? params.agentId;
      if (params.selection?.source === "personal") {
        if (!params.sessionKey) {
          throw new Error("My GitHub publication requires an explicit session.");
        }
        const action = preparePersonalGitHubSessionAction(options, {
          sessionKey: params.sessionKey,
          agentId,
        });
        const result = await coordinator.requestPersonalForSession(params, action);
        action.assertCurrent();
        respond(true, result);
        return;
      }
      const loaded = loadGatewaySessionEntryReadOnly(sessionKey, agentId ? { agentId } : undefined);
      if (!loaded.entry?.sessionId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "GitHub publication session was not found"),
        );
        return;
      }
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
    },
  ),
  "sessions.github.options": defineSessionGitHubMethod(
    "sessions.github.options",
    validateSessionGitHubOptionsParams,
    async (options) => {
      const read = prepareGitHubPublicationOptionsRead(options, options.params);
      let shared = null;
      try {
        const identity = await prepareCurrentGitHubPublicationIdentity(read.session.agentId);
        shared = {
          source: identity.source,
          accountId: identity.account.accountId,
          login: identity.account.login,
        };
      } catch {
        /* An unavailable shared account must not hide the caller's personal option. */
      }
      const service = options.context.githubOAuthService?.personal;
      if (
        read.personal.kind === "eligible" &&
        (!service || !options.context.githubPublicationService)
      ) {
        throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
      }
      const action = read.personal.kind === "eligible" ? read.personal.action : null;
      const personal = action ? await service!.status(action) : null;
      const session = read.currentSession();
      options.respond(true, {
        personal,
        shared,
        pendingPersonal: action
          ? options.context.githubPublicationService!.personalPending(action, session)
          : null,
      });
    },
  ),
  "sessions.github.status": defineSessionGitHubMethod(
    "sessions.github.status",
    validateSessionGitHubStatusParams,
    (options) => {
      const action = preparePersonalGitHubAction(options);
      const { session } = prepareGitHubPublicationOptionsRead(options, options.params);
      const service = options.context.githubPublicationService;
      if (!service) {
        throw new Error("GitHub publication is unavailable.");
      }
      options.respond(true, service.personalStatus(action, session, options.params.requestId));
    },
  ),
  "sessions.github.confirm": defineSessionGitHubMethod(
    "sessions.github.confirm",
    validateSessionGitHubConfirmParams,
    async (options) => {
      const action = preparePersonalGitHubSessionAction(options, options.params);
      const service = options.context.githubPublicationService;
      if (!service) {
        throw new Error("GitHub publication is unavailable.");
      }
      const result = await service.confirmPersonal(options.params, action);
      action.assertCurrent();
      options.respond(true, result);
    },
  ),
};
