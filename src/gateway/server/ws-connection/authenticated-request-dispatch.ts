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
import { runOutsideGatewayRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { createLazyPromise } from "../../../shared/lazy-runtime.js";
import { classifyGatewayStaleInstall } from "../../stale-install.js";
import { formatForLog, logWs } from "../../ws-log.js";
import type { GatewayWsClient } from "../ws-types.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";
import { scheduleGatewayRequestStart } from "./request-start.js";
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

  const dispatch = async (
    parsed: unknown,
    client: GatewayWsClient,
    frameBytes: number,
  ): Promise<void> => {
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
    const hasCurrentClientAuthority = () => {
      if (closeInvalidatedClient(client, req.method)) {
        return false;
      }
      const requiredGeneration = client.usesSharedGatewayAuth
        ? getRequiredSharedGatewaySessionGeneration?.()
        : undefined;
      if (
        requiredGeneration !== undefined &&
        client.sharedGatewaySessionGeneration !== requiredGeneration
      ) {
        setCloseCause("gateway-auth-rotated", { authGenerationStale: true, method: req.method });
        close(4001, "gateway auth changed");
        return false;
      }
      return true;
    };
    if (!hasCurrentClientAuthority()) {
      return;
    }
    const respond = (
      ok: boolean,
      payload?: unknown,
      error?: ErrorShape,
      meta?: Record<string, unknown>,
    ) => {
      let responseOk = ok;
      let responseError = error;
      const sendResult = send({ type: "res", id: req.id, ok, payload, error });
      if (sendResult.kind === "serialization") {
        const detail = formatForLog(sendResult.error);
        logGateway.error(`response serialization failed method=${req.method}: ${detail}`);
        responseOk = false;
        responseError = errorShape(ErrorCodes.UNAVAILABLE, "response serialization failed");
        send({ type: "res", id: req.id, ok: responseOk, error: responseError });
      }
      const unauthorizedRoleError = isUnauthorizedRoleError(responseError);
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
        ok: responseOk,
        method: req.method,
        errorCode: responseError?.code,
        errorMessage: responseError?.message,
        ...logMeta,
      });
    };

    const context = buildRequestContext();
    const agentRuntimeIdentity = client.internal?.agentRuntimeIdentity;
    const hasCurrentRuntimeAuthority = () => {
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
        return false;
      }
      return true;
    };
    if (!hasCurrentRuntimeAuthority()) {
      return;
    }
    const respondWithAuthority: typeof respond = (ok, payload, error, meta) => {
      if (hasCurrentRuntimeAuthority()) {
        respond(ok, payload, error, meta);
      }
    };

    const executeRequest = async () => {
      // Most UI/SDK RPCs outlive a reconnect. Companion asks are the exception:
      // without their requester there is no safe recipient for a late answer.
      const cancelOnDisconnect =
        req.method === "sessions.companion.ask" ||
        (req.method === "node.invoke" &&
          client.connect.client.id === GATEWAY_CLIENT_IDS.CLI &&
          client.connect.client.mode === GATEWAY_CLIENT_MODES.CLI);
      const requestController = cancelOnDisconnect ? new AbortController() : undefined;
      const cancelRequest = () => requestController?.abort();
      if (requestController) {
        client.socket.once("close", cancelRequest);
      }
      try {
        const { handleGatewayRequest } = await loadGatewayServerMethods();
        // Node completion traffic retains its native yielding and existing close-drain
        // deadline. Operator requests share bounded starts without serializing completion.
        if (client.connect.role === "operator") {
          const start = scheduleGatewayRequestStart(frameBytes);
          if (!start) {
            respondWithAuthority(
              false,
              undefined,
              errorShape(ErrorCodes.UNAVAILABLE, "gateway request start capacity exceeded", {
                retryable: true,
              }),
            );
            return;
          }
          await start;
        }
        // Waiting never grants authority. Ordinary requests may outlive their socket;
        // only request-owned cancellation and current authority fence their start.
        if (
          requestController?.signal.aborted ||
          !hasCurrentClientAuthority() ||
          !hasCurrentRuntimeAuthority()
        ) {
          return;
        }
        await runOutsideGatewayRootWorkAdmission(() =>
          handleGatewayRequest({
            req,
            respond: respondWithAuthority,
            client,
            isWebchatConnect: params.isWebchatConnect,
            extraHandlers,
            methodRegistry: getMethodRegistry?.(),
            context,
            ...(requestController ? { signal: requestController.signal } : {}),
          }),
        );
      } catch (err) {
        // Failure diagnostics and responses belong to the same request trace as the handler.
        logGateway.error(`request handler failed: ${formatForLog(err)}`);
        const staleInstall = classifyGatewayStaleInstall(err);
        respondWithAuthority(
          false,
          undefined,
          staleInstall?.error ?? errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
        );
      } finally {
        if (requestController) {
          client.socket.off("close", cancelRequest);
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
