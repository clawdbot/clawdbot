import {
  ErrorCodes,
  errorShape,
  validateSessionGitHubPublishParams,
  validateSessionGitHubOptionsParams,
  validateSessionGitHubStatusParams,
  validateSessionGitHubConfirmParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { prepareCurrentGitHubPublicationIdentity } from "../github-publication-availability.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import {
  preparePersonalGitHubAction,
  prepareGitHubPublicationOptionsRead,
  preparePersonalGitHubSessionAction,
} from "./github-personal-authorization.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const sessionsGitHubHandlers: GatewayRequestHandlers = {
  "sessions.github.publish": defineValidatedGatewayMethod(
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
      if (!sessionKey || (caller && params.sessionKey && params.sessionKey !== caller.sessionKey)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "GitHub publication session is invalid"),
        );
        return;
      }
      try {
        if (params.selection?.source === "personal") {
          if (!params.sessionKey) {
            throw new Error("My GitHub publication requires an explicit session.");
          }
          const action = preparePersonalGitHubSessionAction(options, params.sessionKey);
          const result = await coordinator.requestPersonalForSession(params, action);
          action.assertCurrent();
          respond(true, result);
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
  ),
  "sessions.github.options": defineValidatedGatewayMethod(
    "sessions.github.options",
    validateSessionGitHubOptionsParams,
    async (options) => {
      try {
        const read = prepareGitHubPublicationOptionsRead(options, options.params.sessionKey);
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
      } catch (error) {
        options.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.FORBIDDEN,
            error instanceof Error ? error.message : "GitHub publication options are unavailable.",
          ),
        );
      }
    },
  ),
  "sessions.github.status": defineValidatedGatewayMethod(
    "sessions.github.status",
    validateSessionGitHubStatusParams,
    (options) => {
      try {
        const action = preparePersonalGitHubAction(options);
        const { session } = prepareGitHubPublicationOptionsRead(options, options.params.sessionKey);
        const service = options.context.githubPublicationService;
        if (!service) {
          throw new Error("GitHub publication is unavailable.");
        }
        options.respond(true, service.personalStatus(action, session, options.params.requestId));
      } catch (error) {
        options.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.FORBIDDEN,
            error instanceof Error ? error.message : "GitHub publication status is unavailable.",
          ),
        );
      }
    },
  ),
  "sessions.github.confirm": defineValidatedGatewayMethod(
    "sessions.github.confirm",
    validateSessionGitHubConfirmParams,
    async (options) => {
      try {
        const action = preparePersonalGitHubSessionAction(options, options.params.sessionKey);
        const service = options.context.githubPublicationService;
        if (!service) {
          throw new Error("GitHub publication is unavailable.");
        }
        const result = await service.confirmPersonal(options.params, action);
        action.assertCurrent();
        options.respond(true, result);
      } catch (error) {
        options.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.FORBIDDEN,
            error instanceof Error ? error.message : "GitHub publication confirmation failed.",
          ),
        );
      }
    },
  ),
};
