// Commands gateway methods expose validated command listing for a resolved
// agent, provider, scope, and argument-detail request.
import { validateCommandsListParams } from "../../../packages/gateway-protocol/src/index.js";
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
    ({ params, respond, context }) => {
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
        normalize: (rawAgentId) => (typeof rawAgentId === "string" ? rawAgentId.trim() : undefined),
      });
      if (!resolved) {
        return;
      }
      respond(
        true,
        buildCommandsListResult({
          cfg: resolved.cfg,
          agentId: resolved.agentId,
          provider: params.provider,
          scope: params.scope,
          includeArgs: params.includeArgs,
        }),
        undefined,
      );
    },
  ),
};
