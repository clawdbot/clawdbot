import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type PortalCloseParams,
  type PortalOpenParams,
  type PortalSummary,
  validatePortalCloseParams,
  validatePortalListParams,
  validatePortalOpenParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function invalidParams(method: string, errors: unknown, respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors as never)}`,
    ),
  );
}

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
  "portal.list": ({ params, respond, context, client }) => {
    if (!validatePortalListParams(params)) {
      invalidParams("portal.list", validatePortalListParams.errors, respond);
      return;
    }
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
  "portal.open": async ({ params, respond, context }) => {
    if (!validatePortalOpenParams(params)) {
      invalidParams("portal.open", validatePortalOpenParams.errors, respond);
      return;
    }
    const service = requirePortalService(context, respond);
    if (!service) {
      return;
    }
    try {
      const request = params as PortalOpenParams;
      const portal = await service.open({
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
      respond(true, portal, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error instanceof Error ? error.message : String(error)),
      );
    }
  },
  "portal.close": async ({ params, respond, context }) => {
    if (!validatePortalCloseParams(params)) {
      invalidParams("portal.close", validatePortalCloseParams.errors, respond);
      return;
    }
    const service = requirePortalService(context, respond);
    if (!service) {
      return;
    }
    try {
      await service.close((params as PortalCloseParams).id);
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
        errorShape(ErrorCodes.UNAVAILABLE, error instanceof Error ? error.message : String(error)),
      );
    }
  },
};
