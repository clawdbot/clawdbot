import {
  type AgentWaitParams,
  type ErrorShape,
  validateAgentParams,
  validateAgentWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayMethodRegistry } from "../methods/registry.js";
import {
  type GatewayMethodDispatchResponse,
  throwIfGatewayDispatchAborted,
  waitForGatewayDispatch,
  unwrapGatewayMethodDispatchResponse,
} from "../server-in-process-dispatch.js";
import {
  authorizeGatewayRequestPreDispatch,
  createRequestGatewayMethodRegistry,
  runWithGatewayRequestEnvelope,
} from "../server-methods.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import type { GatewayRequestOptions } from "../server-methods/types.js";
import { validateGatewayMethodParams } from "../server-methods/validation.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";
import { createAgentTurnService } from "./agent-turn-service.js";
import { captureAgentTurnPrincipal, resolveAgentTurnRunObserver } from "./principal.js";
import type { AgentTurnIo } from "./types.js";

type InternalAgentTurnFacadeOptions = {
  client: NonNullable<GatewayRequestOptions["client"]>;
  getContext: () => GatewayRequestOptions["context"];
  getMethodRegistry?: () => GatewayMethodRegistry;
  isWebchatConnect?: GatewayRequestOptions["isWebchatConnect"];
};

type InternalAgentTurnDispatchOptions = {
  expectFinal?: boolean;
  onAccepted?: (payload: unknown) => void;
  onSignalAbort?: () => Promise<void> | void;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function throwEnvelopeRejection(method: string, error: ErrorShape): never {
  return unwrapGatewayMethodDispatchResponse(method, {
    ok: false,
    error,
  }) as never;
}

/** Typed, frame-free access to agent turns owned by the running Gateway instance. */
export function createInternalAgentTurnFacade(options: InternalAgentTurnFacadeOptions) {
  const isWebchatConnect = options.isWebchatConnect ?? (() => false);
  const getMethodRegistry = options.getMethodRegistry ?? createRequestGatewayMethodRegistry;

  const dispatchRaw = async (
    request: AgentRunRequest,
    dispatchOptions: InternalAgentTurnDispatchOptions = {},
  ): Promise<GatewayMethodDispatchResponse> => {
    const method = "agent";
    throwIfGatewayDispatchAborted(method, dispatchOptions.signal);
    const context = options.getContext();
    const methodRegistry = getMethodRegistry();
    const authorization = await authorizeGatewayRequestPreDispatch({
      method,
      requestParams: request,
      client: options.client,
      context,
      methodRegistry,
    });
    if (authorization.error) {
      return { ok: false, error: authorization.error };
    }
    const validationError = validateGatewayMethodParams(request, validateAgentParams, method);
    if (validationError) {
      return { ok: false, error: validationError };
    }
    let acceptance: GatewayMethodDispatchResponse | undefined;
    let final: GatewayMethodDispatchResponse | undefined;
    let resolveAcceptance: ((response: GatewayMethodDispatchResponse) => void) | undefined;
    let rejectAcceptance: ((error: Error) => void) | undefined;
    let resolveFinal: ((response: GatewayMethodDispatchResponse) => void) | undefined;
    let rejectFinal: ((error: Error) => void) | undefined;
    let postAcceptanceError: Error | undefined;
    const acceptancePromise = new Promise<GatewayMethodDispatchResponse>((resolve, reject) => {
      resolveAcceptance = resolve;
      rejectAcceptance = reject;
    });
    const createFinalPromise = () =>
      new Promise<GatewayMethodDispatchResponse>((resolve, reject) => {
        resolveFinal = resolve;
        rejectFinal = reject;
        if (final) {
          resolve(final);
        }
      });
    const io: AgentTurnIo = {
      emitAcceptance: (frame, meta) => {
        if (!acceptance) {
          acceptance = {
            ok: frame[0],
            payload: frame[1],
            error: frame[2],
            ...(meta ? { meta } : {}),
          };
          resolveAcceptance?.(acceptance);
        }
      },
      emitFinal: (frame, meta) => {
        if (!final) {
          final = {
            ok: frame[0],
            payload: frame[1],
            error: frame[2],
            ...(meta ? { meta } : {}),
          };
          resolveFinal?.(final);
        }
      },
    };
    const operation = runWithGatewayRequestEnvelope(
      method,
      options.client,
      async () => {
        const principal = captureAgentTurnPrincipal(options.client);
        const preflight = prepareAgentRequestPreflight({
          request,
          context,
          client: principal,
          io,
        });
        if (!preflight) {
          return;
        }
        const onRunObserved = resolveAgentTurnRunObserver({
          principal,
          registerToolEventRecipient: context.registerToolEventRecipient,
        });
        await createAgentTurnService({ context, isWebchatConnect }).startTurn({
          preflight,
          principal,
          io,
          onRunObserved,
        });
      },
      {
        context,
        isWebchatConnect,
        methodRegistry,
        reject: (error) => io.emitAcceptance([false, undefined, error]),
      },
    );
    void operation.then(
      () => {
        if (!acceptance) {
          rejectAcceptance?.(new Error(`Gateway method "${method}" completed without a response.`));
        }
      },
      (error: unknown) => {
        const dispatchError = error instanceof Error ? error : new Error(String(error));
        if (acceptance) {
          postAcceptanceError = dispatchError;
          rejectFinal?.(dispatchError);
          return;
        }
        rejectAcceptance?.(dispatchError);
      },
    );
    const response = (async () => {
      const first = acceptance ?? (await acceptancePromise);
      if (
        dispatchOptions.expectFinal !== true ||
        (first.payload as { status?: unknown } | undefined)?.status !== "accepted"
      ) {
        return first;
      }
      dispatchOptions.onAccepted?.(first.payload);
      if (postAcceptanceError) {
        throw postAcceptanceError;
      }
      return final ?? (await createFinalPromise());
    })();
    return await waitForGatewayDispatch(
      method,
      response,
      dispatchOptions.timeoutMs,
      dispatchOptions.signal,
      dispatchOptions.onSignalAbort,
    );
  };

  const dispatch = async <T = unknown>(
    request: AgentRunRequest,
    dispatchOptions: InternalAgentTurnDispatchOptions | number = {},
  ): Promise<T> => {
    const normalizedOptions =
      typeof dispatchOptions === "number" ? { timeoutMs: dispatchOptions } : dispatchOptions;
    return unwrapGatewayMethodDispatchResponse(
      "agent",
      await dispatchRaw(request, normalizedOptions),
    ) as T;
  };

  const wait = async <T = unknown>(
    params: AgentWaitParams,
    timeoutMs?: number,
    signal?: AbortSignal,
    onSignalAbort?: () => Promise<void> | void,
  ): Promise<T> => {
    const method = "agent.wait";
    throwIfGatewayDispatchAborted(method, signal);
    const context = options.getContext();
    const methodRegistry = getMethodRegistry();
    const authorization = await authorizeGatewayRequestPreDispatch({
      method,
      requestParams: params,
      client: options.client,
      context,
      methodRegistry,
    });
    if (authorization.error) {
      return throwEnvelopeRejection(method, authorization.error);
    }
    const validationError = validateGatewayMethodParams(params, validateAgentWaitParams, method);
    if (validationError) {
      return throwEnvelopeRejection(method, validationError);
    }
    const result = runWithGatewayRequestEnvelope(
      method,
      options.client,
      () => createAgentTurnService({ context, isWebchatConnect }).waitForTurn(params),
      {
        context,
        isWebchatConnect,
        methodRegistry,
        reject: (error) => throwEnvelopeRejection(method, error),
      },
    );
    return (await waitForGatewayDispatch(method, result, timeoutMs, signal, onSignalAbort)) as T;
  };

  return { dispatch, dispatchRaw, wait };
}
