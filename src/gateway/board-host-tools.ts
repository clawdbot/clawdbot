import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import { CORE_BOARD_DATA_BINDING_IDS } from "../boards/board-host-capability-ids.js";
import { BoardValidationError } from "../boards/board-layout.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { agentsHandlers } from "./server-methods/agents.js";
import { cronHandlers } from "./server-methods/cron.js";
import { healthHandlers } from "./server-methods/health.js";
import { sessionsHandlers } from "./server-methods/sessions.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { usageHandlers } from "./server-methods/usage.js";

type BoardDataBindingId = (typeof CORE_BOARD_DATA_BINDING_IDS)[number];
type GatewayHandlerInvocation = Parameters<GatewayRequestHandlers[string]>[0];

const BOARD_DATA_HANDLERS: Record<BoardDataBindingId, GatewayRequestHandlers[string]> = {
  "sessions.list": sessionsHandlers["sessions.list"]!,
  "usage.status": usageHandlers["usage.status"]!,
  "usage.cost": usageHandlers["usage.cost"]!,
  "cron.list": cronHandlers["cron.list"]!,
  "cron.status": cronHandlers["cron.status"]!,
  "agents.list": agentsHandlers["agents.list"]!,
  health: healthHandlers.health!,
};

function isBoardDataBindingId(value: string): value is BoardDataBindingId {
  return (CORE_BOARD_DATA_BINDING_IDS as readonly string[]).includes(value);
}

async function invokeGatewayHandler(
  handler: GatewayRequestHandlers[string],
  method: string,
  params: Record<string, unknown>,
  invocation: GatewayHandlerInvocation,
): Promise<unknown> {
  let didRespond = false;
  let succeeded = false;
  let payload: unknown;
  let responseError: ErrorShape | undefined;
  await handler({
    ...invocation,
    req: { ...invocation.req, method, params },
    params,
    respond: (ok, value, error) => {
      if (didRespond) {
        return;
      }
      didRespond = true;
      if (ok) {
        succeeded = true;
        payload = value;
      } else {
        responseError = error;
      }
    },
  });
  if (!didRespond) {
    throw new BoardValidationError("invalid_operation", `${method} did not return a result`);
  }
  if (!succeeded) {
    throw new BoardValidationError(
      "invalid_operation",
      responseError?.message || `${method} failed`,
    );
  }
  return payload;
}

export async function readBoardDataBinding(
  bindingId: string,
  params: Record<string, unknown>,
  invocation: GatewayHandlerInvocation,
): Promise<unknown> {
  if (isBoardDataBindingId(bindingId)) {
    return await invokeGatewayHandler(
      BOARD_DATA_HANDLERS[bindingId],
      bindingId,
      params,
      invocation,
    );
  }
  const registration = getActivePluginRegistry()?.dashboardDataBindings.get(bindingId);
  if (!registration) {
    throw new BoardValidationError(
      "invalid_operation",
      `board widget data binding is not allowed: ${bindingId}`,
    );
  }
  return await invokeGatewayHandler(registration.handler, registration.method, params, invocation);
}

export async function runBoardActionVerb(
  actionId: string,
  params: Record<string, unknown>,
  invocation: GatewayHandlerInvocation,
): Promise<unknown> {
  const registration = getActivePluginRegistry()?.dashboardActionVerbs.get(actionId);
  if (!registration) {
    throw new BoardValidationError(
      "invalid_operation",
      `board widget action verb is not allowed: ${actionId}`,
    );
  }
  if (registration.paramShape) {
    const validation = validateJsonSchemaValue({
      schema: registration.paramShape,
      cacheKey: `dashboard-action:${registration.pluginId}:${registration.id}`,
      value: params,
    });
    if (!validation.ok) {
      throw new BoardValidationError(
        "invalid_operation",
        `board widget action params do not match ${actionId}: ${validation.errors.map((error) => error.text).join(", ")}`,
      );
    }
  }
  return await invokeGatewayHandler(registration.handler, registration.method, params, invocation);
}

export async function triggerBoardCronJob(
  jobId: string,
  invocation: GatewayHandlerInvocation,
): Promise<unknown> {
  return await invokeGatewayHandler(
    cronHandlers["cron.run"]!,
    "cron.run",
    { id: jobId, mode: "force" },
    invocation,
  );
}
