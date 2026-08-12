import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type PortalCloseParams,
  type PortalOpenParams,
  validatePortalCloseParams,
  validatePortalListParams,
  validatePortalOpenParams,
} from "../../../packages/gateway-protocol/src/index.js";
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

export const portalHandlers: GatewayRequestHandlers = {
  "portal.list": ({ params, respond, context }) => {
    if (!validatePortalListParams(params)) {
      invalidParams("portal.list", validatePortalListParams.errors, respond);
      return;
    }
    const service = requirePortalService(context, respond);
    if (!service) {
      return;
    }
    respond(true, { portals: service.list() }, undefined);
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
      context.broadcast("portal.changed", { portals: service.list() }, { dropIfSlow: true });
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
      context.broadcast("portal.changed", { portals: service.list() }, { dropIfSlow: true });
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
