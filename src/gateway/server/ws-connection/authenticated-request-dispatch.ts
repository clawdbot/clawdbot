import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams, ErrorShape } from "../../../../packages/gateway-protocol/src/index.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateRequestFrame,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  createChildDiagnosticTraceContext,
  parseDiagnosticTraceparent,
  runWithDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { createLazyPromise } from "../../../shared/lazy-runtime.js";
import { formatForLog, logWs } from "../../ws-log.js";
import type { GatewayWsClient } from "../ws-types.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";
import { isUnauthorizedRoleError, UnauthorizedFloodGuard } from "./unauthorized-flood-guard.js";

const loadGatewayServerMethods = createLazyPromise(
  () => import("./authenticated-request-dispatch.server-methods.runtime.js"),
);

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

    const context = buildRequestContext();
    const agentRuntimeIdentity = client.internal?.agentRuntimeIdentity;
    if (
      agentRuntimeIdentity &&
      context.validateAgentRuntimeApprovalAuthority?.(agentRuntimeIdentity) !== true
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
      );
      setCloseCause("agent-runtime-authority-closed", { method: req.method });
      close(4001, "agent runtime authority closed");
      return;
    }
    const respondWithAuthority: typeof respond = (ok, payload, error, meta) => {
      if (
        agentRuntimeIdentity &&
        context.validateAgentRuntimeApprovalAuthority?.(agentRuntimeIdentity) !== true
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
        );
        setCloseCause("agent-runtime-authority-closed", { method: req.method });
        close(4001, "agent runtime authority closed");
        return;
      }
      respond(ok, payload, error, meta);
    };

    const executeRequest = async () => {
      // One-shot CLI clients cancel by closing their authenticated socket;
      // leave long-lived SDK/UI invocations independent of connection teardown.
      const nodeInvocationController =
        req.method === "node.invoke" &&
        client.connect.client.id === GATEWAY_CLIENT_IDS.CLI &&
        client.connect.client.mode === GATEWAY_CLIENT_MODES.CLI
          ? new AbortController()
          : undefined;
      const cancelNodeInvocation = () => nodeInvocationController?.abort();
      if (nodeInvocationController) {
        client.socket.once("close", cancelNodeInvocation);
      }
      try {
        const { handleGatewayRequest } = await loadGatewayServerMethods();
        await handleGatewayRequest({
          req,
          respond: respondWithAuthority,
          client,
          isWebchatConnect: params.isWebchatConnect,
          extraHandlers,
          methodRegistry: getMethodRegistry?.(),
          context,
          ...(nodeInvocationController ? { signal: nodeInvocationController.signal } : {}),
        });
      } catch (err) {
        // Failure diagnostics and responses belong to the same request trace as the handler.
        logGateway.error(`request handler failed: ${formatForLog(err)}`);
        respondWithAuthority(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
        );
      } finally {
        if (nodeInvocationController) {
          client.socket.off("close", cancelNodeInvocation);
        }
      }
    };
    const upstreamTrace = parseDiagnosticTraceparent(req.traceparent);
    const dispatchRequest = () =>
      upstreamTrace
        ? runWithDiagnosticTraceContext(
            createChildDiagnosticTraceContext(upstreamTrace),
            executeRequest,
          )
        : executeRequest();
    const requestDispatch =
      client.connect.role === "node"
        ? params.handler.nodeLifecycleDispatch.dispatch(req.method, dispatchRequest)
        : dispatchRequest();
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
