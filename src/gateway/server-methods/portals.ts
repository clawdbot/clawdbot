import {
  ErrorCodes,
  errorShape,
  type PortalSummary,
  validatePortalCloseParams,
  validatePortalListParams,
  validatePortalOpenParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

function requirePortalService(
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  respond: RespondFn,
) {
  const service = context.portalService;
  if (!service) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "portals unavailable"));
  }
  return service;
}

function redactPortalSummary(summary: PortalSummary): PortalSummary {
  const { tokenQuery: _tokenQuery, url: _url, ...redacted } = summary;
  return redacted;
}

export const portalHandlers: GatewayRequestHandlers = {
  "portal.list": defineValidatedGatewayMethod(
    "portal.list",
    validatePortalListParams,
    ({ respond, context, client }) => {
      const service = requirePortalService(context, respond);
      if (!service) {
        return;
      }
      const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
      const portals = service.list();
      respond(
        true,
        {
          portals:
            scopes.includes(WRITE_SCOPE) || scopes.includes(ADMIN_SCOPE)
              ? portals
              : portals.map(redactPortalSummary),
        },
        undefined,
      );
    },
  ),
  "portal.open": defineValidatedGatewayMethod(
    "portal.open",
    validatePortalOpenParams,
    async ({ params: request, respond, context }) => {
      const service = requirePortalService(context, respond);
      if (!service) {
        return;
      }
      try {
        const opened = await service.open({
          targetPort: request.port,
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(request.description !== undefined ? { description: request.description } : {}),
          ...(request.path !== undefined ? { path: request.path } : {}),
        });
        context.broadcast(
          "portal.changed",
          { portals: service.list().map(redactPortalSummary) },
          { dropIfSlow: true },
        );
        respond(true, opened, undefined);
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    },
  ),
  "portal.close": defineValidatedGatewayMethod(
    "portal.close",
    validatePortalCloseParams,
    async ({ params, respond, context }) => {
      const service = requirePortalService(context, respond);
      if (!service) {
        return;
      }
      try {
        await service.close(params.id);
        context.broadcast(
          "portal.changed",
          { portals: service.list().map(redactPortalSummary) },
          { dropIfSlow: true },
        );
        respond(true, { closed: true }, undefined);
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    },
  ),
};
