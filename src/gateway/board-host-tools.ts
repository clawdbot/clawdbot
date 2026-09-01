import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { CORE_BOARD_DATA_BINDING_IDS } from "../boards/board-host-capability-ids.js";
import { BoardValidationError } from "../boards/board-layout.js";
import { BoardEventPayloadError } from "../boards/board-notices.js";
import {
  capturePluginRegistryLifecycleEpoch,
  isPluginRegistryLifecycleEpochActive,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { isGatewaySubordinateWorkAdmissionClosed } from "../process/gateway-work-admission.js";
import {
  BoardGatewayUnavailableError,
  type BoardViewTicketAuthorityInput,
} from "./board-view-ticket.js";
import { agentsHandlers } from "./server-methods/agents.js";
import { cronHandlers } from "./server-methods/cron.js";
import { healthHandlers } from "./server-methods/health.js";
import { sessionReadHandlers } from "./server-methods/sessions-read.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { usageHandlers } from "./server-methods/usage.js";

type BoardDataBindingId = (typeof CORE_BOARD_DATA_BINDING_IDS)[number];
type GatewayHandlerInvocation = Parameters<GatewayRequestHandlers[string]>[0];

export type BoardRequestAuthority = {
  assertActive: () => void;
  pluginRegistry?: PluginRegistry;
  ticketAuthority: BoardViewTicketAuthorityInput;
};

export function captureBoardRequestAuthority(
  invocation: GatewayHandlerInvocation,
): BoardRequestAuthority {
  const context = invocation.context;
  const resolveGatewayContext = context.resolveGatewayContext;
  if (!resolveGatewayContext) {
    throw new BoardGatewayUnavailableError();
  }
  const methodRegistry = context.getGatewayMethodRegistry?.();
  const pluginRegistry =
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry() ?? undefined;
  const pluginRegistryEpoch = pluginRegistry
    ? capturePluginRegistryLifecycleEpoch(pluginRegistry)
    : undefined;
  const assertActive = () => {
    try {
      if (
        isGatewaySubordinateWorkAdmissionClosed() ||
        resolveGatewayContext() !== context ||
        context.resolveGatewayContext !== resolveGatewayContext ||
        (methodRegistry && context.getGatewayMethodRegistry?.() !== methodRegistry) ||
        (pluginRegistry &&
          (!pluginRegistryEpoch ||
            !isPluginRegistryLifecycleEpochActive(pluginRegistry, pluginRegistryEpoch)))
      ) {
        throw new BoardGatewayUnavailableError();
      }
    } catch (error) {
      if (error instanceof BoardGatewayUnavailableError) {
        throw error;
      }
      throw new BoardGatewayUnavailableError();
    }
  };
  assertActive();
  return {
    assertActive,
    ...(pluginRegistry ? { pluginRegistry } : {}),
    ticketAuthority: {
      gatewayContext: context,
      resolveGatewayContext,
      ...(pluginRegistry ? { pluginRegistry } : {}),
    },
  };
}

export function respondBoardError(
  error: unknown,
  respond: GatewayHandlerInvocation["respond"],
): void {
  if (error instanceof BoardGatewayUnavailableError) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error.message));
    return;
  }
  if (error instanceof BoardValidationError || error instanceof BoardEventPayloadError) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    return;
  }
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
}

const BOARD_DATA_HANDLERS: Record<BoardDataBindingId, GatewayRequestHandlers[string]> = {
  "sessions.list": sessionReadHandlers["sessions.list"]!,
  // Board reads are one-shot and cannot converge an incomplete marker.
  "usage.status": (invocation) => usageHandlers["usage.status"]!({ ...invocation, client: null }),
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
  authority: BoardRequestAuthority,
): Promise<unknown> {
  let didRespond = false;
  let succeeded = false;
  let payload: unknown;
  let responseError: ErrorShape | undefined;
  authority.assertActive();
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
  authority.assertActive();
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
  authority: BoardRequestAuthority = captureBoardRequestAuthority(invocation),
): Promise<unknown> {
  if (isBoardDataBindingId(bindingId)) {
    return await invokeGatewayHandler(
      BOARD_DATA_HANDLERS[bindingId],
      bindingId,
      params,
      invocation,
      authority,
    );
  }
  const registration = authority.pluginRegistry?.dashboardDataBindings.get(bindingId);
  if (!registration) {
    throw new BoardValidationError(
      "invalid_operation",
      `board widget data binding is not allowed: ${bindingId}`,
    );
  }
  return await invokeGatewayHandler(
    registration.handler,
    registration.method,
    params,
    invocation,
    authority,
  );
}

export async function runBoardActionVerb(
  actionId: string,
  params: Record<string, unknown>,
  invocation: GatewayHandlerInvocation,
  authority: BoardRequestAuthority = captureBoardRequestAuthority(invocation),
): Promise<unknown> {
  const registration = authority.pluginRegistry?.dashboardActionVerbs.get(actionId);
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
  return await invokeGatewayHandler(
    registration.handler,
    registration.method,
    params,
    invocation,
    authority,
  );
}

export async function triggerBoardCronJob(
  jobId: string,
  invocation: GatewayHandlerInvocation,
  authority: BoardRequestAuthority = captureBoardRequestAuthority(invocation),
): Promise<unknown> {
  return await invokeGatewayHandler(
    cronHandlers["cron.run"]!,
    "cron.run",
    { id: jobId, mode: "force" },
    invocation,
    authority,
  );
}
