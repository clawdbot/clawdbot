import type { ConnectParams, ErrorShape } from "../../../../packages/gateway-protocol/src/index.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateRequestFrame,
} from "../../../../packages/gateway-protocol/src/index.js";
import { formatForLog, logWs } from "../../ws-log.js";
import type { GatewayWsClient } from "../ws-types.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";
import { isUnauthorizedRoleError, UnauthorizedFloodGuard } from "./unauthorized-flood-guard.js";

const DEVICE_CREDENTIAL_INVALIDATING_METHODS = new Set([
  "device.pair.remove",
  "device.token.rotate",
  "device.token.revoke",
  "node.pair.remove",
]);

export function createGatewayAuthenticatedRequestDispatcher(params: {
  handler: GatewayWsMessageHandlerParams;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
}) {
  const {
    connId,
    getRequiredSharedGatewaySessionGeneration,
    extraHandlers,
    getMethodRegistry,
    buildRequestContext,
    send,
    close,
    isClosed,
    setCloseCause,
    logGateway,
  } = params.handler;
  const unauthorizedFloodGuard = new UnauthorizedFloodGuard();
  let deviceCredentialMutationBarrier: Promise<void> | undefined;

  const closeInvalidatedClient = (client: GatewayWsClient, method: string): boolean => {
    if (!client.invalidated) {
      return false;
    }
    const reason = client.invalidatedReason ?? "invalidated";
    setCloseCause("client-invalidated", {
      reason,
      method,
    });
    close(4001, `client invalidated: ${reason}`);
    return true;
  };

  const dispatch = async (parsed: unknown, client: GatewayWsClient): Promise<void> => {
    // After handshake, accept only req frames
    if (!validateRequestFrame(parsed)) {
      send({
        type: "res",
        id: (parsed as { id?: unknown })?.id ?? "invalid",
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid request frame: ${formatValidationErrors(validateRequestFrame.errors)}`,
        ),
      });
      return;
    }
    const req = parsed;
    logWs("in", "req", { connId, id: req.id, method: req.method });
    for (;;) {
      const barrier = deviceCredentialMutationBarrier;
      if (!barrier) {
        break;
      }
      await barrier.catch(() => undefined);
      if (isClosed()) {
        return;
      }
    }
    if (closeInvalidatedClient(client, req.method)) {
      return;
    }
    if (client.usesSharedGatewayAuth) {
      const requiredSharedGatewaySessionGeneration = getRequiredSharedGatewaySessionGeneration?.();
      if (
        requiredSharedGatewaySessionGeneration !== undefined &&
        client.sharedGatewaySessionGeneration !== requiredSharedGatewaySessionGeneration
      ) {
        setCloseCause("gateway-auth-rotated", {
          authGenerationStale: true,
          method: req.method,
        });
        close(4001, "gateway auth changed");
        return;
      }
    }
    const respond = (
      ok: boolean,
      payload?: unknown,
      error?: ErrorShape,
      meta?: Record<string, unknown>,
    ) => {
      send({ type: "res", id: req.id, ok, payload, error });
      const unauthorizedRoleError = isUnauthorizedRoleError(error);
      let logMeta = meta;
      if (unauthorizedRoleError) {
        const unauthorizedDecision = unauthorizedFloodGuard.registerUnauthorized();
        if (unauthorizedDecision.suppressedSinceLastLog > 0) {
          logMeta = {
            ...logMeta,
            suppressedUnauthorizedResponses: unauthorizedDecision.suppressedSinceLastLog,
          };
        }
        if (!unauthorizedDecision.shouldLog) {
          return;
        }
        if (unauthorizedDecision.shouldClose) {
          setCloseCause("repeated-unauthorized-requests", {
            unauthorizedCount: unauthorizedDecision.count,
            method: req.method,
          });
          queueMicrotask(() => close(1008, "repeated unauthorized calls"));
        }
        logMeta = {
          ...logMeta,
          unauthorizedCount: unauthorizedDecision.count,
        };
      } else {
        unauthorizedFloodGuard.reset();
      }
      logWs("out", "res", {
        connId,
        id: req.id,
        ok,
        method: req.method,
        errorCode: error?.code,
        errorMessage: error?.message,
        ...logMeta,
      });
    };

    const requestDispatch = (async () => {
      const { handleGatewayRequest } = await import("../../server-methods.js");
      await handleGatewayRequest({
        req,
        respond,
        client,
        isWebchatConnect: params.isWebchatConnect,
        extraHandlers,
        methodRegistry: getMethodRegistry?.(),
        context: buildRequestContext(),
      });
    })().catch((err: unknown) => {
      logGateway.error(`request handler failed: ${formatForLog(err)}`);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    });
    if (DEVICE_CREDENTIAL_INVALIDATING_METHODS.has(req.method)) {
      const barrier = requestDispatch.finally(() => {
        if (deviceCredentialMutationBarrier === barrier) {
          deviceCredentialMutationBarrier = undefined;
        }
      });
      deviceCredentialMutationBarrier = barrier;
    }
    void requestDispatch;
  };

  return { dispatch };
}
