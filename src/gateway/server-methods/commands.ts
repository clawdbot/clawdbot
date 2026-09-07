// Commands gateway methods expose validated command listing for a resolved
// agent, provider, scope, and argument-detail request.
import {
  ErrorCodes,
  errorShape,
  validateCommandsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { authorizeSessionSharingTarget, resolveSessionSharingTarget } from "../session-sharing.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { buildCommandsListResult } from "./commands-list-result.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export { buildCommandsListResult };

/** Gateway handler for enumerating available chat/native commands. */
export const commandsHandlers: GatewayRequestHandlers = {
  "commands.list": defineValidatedGatewayMethod(
    "commands.list",
    validateCommandsListParams,
    ({ params, respond, context, client }) => {
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
        normalize: (rawAgentId) => (typeof rawAgentId === "string" ? rawAgentId.trim() : undefined),
      });
      if (!resolved) {
        return;
      }
      const target = params.sessionKey
        ? resolveSessionSharingTarget({
            cfg: resolved.cfg,
            sessionKey: params.sessionKey,
            agentId: resolved.agentId,
          })
        : null;
      if (params.sessionKey && !target) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Session not found."));
        return;
      }
      if (target) {
        const error = authorizeSessionSharingTarget({ cfg: resolved.cfg, client, target });
        if (error) {
          respond(false, undefined, error);
          return;
        }
      }
      respond(
        true,
        buildCommandsListResult({
          cfg: resolved.cfg,
          agentId: resolved.agentId,
          provider: params.provider,
          scope: params.scope,
          includeArgs: params.includeArgs,
          sessionKey: params.sessionKey,
          sessionEntry: target?.entry,
        }),
        undefined,
      );
    },
  ),
};
