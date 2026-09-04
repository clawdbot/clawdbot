import {
  type AgentWaitParams,
  type ErrorShape,
  validateAgentParams,
  validateAgentWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "../chat-abort.js";
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
import type {
  InternalAgentTurnDispatchOptions,
  InternalAgentTurnFacade,
  InternalAgentTurnPrincipalOptions,
} from "./internal-facade.types.js";
import { captureAgentTurnPrincipal, resolveAgentTurnRunObserver } from "./principal.js";
import type { AgentTurnIo } from "./types.js";

type InternalAgentTurnFacadeOptions = InternalAgentTurnPrincipalOptions & {
  getContext: () => GatewayRequestOptions["context"];
  getMethodRegistry?: () => GatewayMethodRegistry;
};

function throwEnvelopeRejection(method: string, error: ErrorShape): never {
  return unwrapGatewayMethodDispatchResponse(method, {
    ok: false,
    error,
  }) as never;
}

/** Typed, frame-free access to agent turns owned by the running Gateway instance. */
export function createInternalAgentTurnFacade(
  options: InternalAgentTurnFacadeOptions,
): InternalAgentTurnFacade {
  const isWebchatConnect = options.isWebchatConnect ?? (() => false);
  const getMethodRegistry = options.getMethodRegistry ?? createRequestGatewayMethodRegistry;

  const dispatchRaw = async (
    request: AgentRunRequest,
    dispatchOptions: InternalAgentTurnDispatchOptions = {},
  ): Promise<GatewayMethodDispatchResponse> => {
    const method = "agent";
    throwIfGatewayDispatchAborted(method, dispatchOptions.signal);
    options.assertContextCurrent?.();
    const context = options.getContext();
    const entry = context.requestEntryLifetime?.enter({
      req: { method, params: request },
      client: options.client,
      context,
    });
    try {
      const methodRegistry = getMethodRegistry();
      const authorization = await authorizeGatewayRequestPreDispatch({
        method,
        requestParams: request,
        client: options.client,
        context,
        methodRegistry,
      });
      entry?.assertOpen();
      if (authorization.error) {
        return { ok: false, error: authorization.error };
      }
      const validationError = validateGatewayMethodParams(request, validateAgentParams, method);
      if (validationError) {
        return { ok: false, error: validationError };
      }
      options.assertContextCurrent?.();
      let acceptance: GatewayMethodDispatchResponse | undefined;
      let final: GatewayMethodDispatchResponse | undefined;
      let resolveAcceptance: ((response: GatewayMethodDispatchResponse) => void) | undefined;
      let rejectAcceptance: ((error: Error) => void) | undefined;
      let resolveFinal: ((response: GatewayMethodDispatchResponse) => void) | undefined;
      let rejectFinal: ((error: Error) => void) | undefined;
      let postAcceptanceError: Error | undefined;
      // Acceptance publishes the abort owner before this callback runs. Retain that exact
      // entry so a late deadline cannot cancel a same-run-id successor.
      let acceptedAbortOwner: { entry: ChatAbortControllerEntry; runId: string } | undefined;
      let pendingCancelReason: "rpc" | "timeout" | undefined;
      const cancelAcceptedRun = (reason: "rpc" | "timeout") => {
        pendingCancelReason ??= reason;
        const owner = acceptedAbortOwner;
        if (!owner || context.chatAbortControllers.get(owner.runId) !== owner.entry) {
          return;
        }
        abortChatRunById(context, {
          runId: owner.runId,
          sessionKey: owner.entry.sessionKey,
          stopReason: pendingCancelReason,
        });
      };
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
            const acceptedRunId =
              typeof meta?.runId === "string" && meta.runId.trim() ? meta.runId.trim() : undefined;
            const acceptedEntry = acceptedRunId
              ? context.chatAbortControllers.get(acceptedRunId)
              : undefined;
            if (acceptedRunId && acceptedEntry) {
              acceptedAbortOwner = { entry: acceptedEntry, runId: acceptedRunId };
              if (pendingCancelReason) {
                cancelAcceptedRun(pendingCancelReason);
              }
            }
            if (
              meta?.cached === true &&
              acceptedRunId &&
              context.chatAbortControllers.get(acceptedRunId)?.executionStarted === true
            ) {
              dispatchOptions.onExecutionStarted?.();
            }
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
        ...(dispatchOptions.onExecutionStarted
          ? { emitExecutionStarted: dispatchOptions.onExecutionStarted }
          : {}),
      };
      const operation = runWithGatewayRequestEnvelope(
        method,
        options.client,
        async () => {
          entry?.assertOpen();
          entry?.release();
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
          await createAgentTurnService(
            { context, isWebchatConnect },
            options.assertContextCurrent,
          ).startTurn({ preflight, principal, io, onRunObserved });
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
            rejectAcceptance?.(
              new Error(`Gateway method "${method}" completed without a response.`),
            );
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
        dispatchOptions.cancelOnDeadline || dispatchOptions.onSignalAbort
          ? async () => {
              if (dispatchOptions.cancelOnDeadline) {
                cancelAcceptedRun("rpc");
              }
              await dispatchOptions.onSignalAbort?.();
            }
          : undefined,
        dispatchOptions.cancelOnDeadline ? () => cancelAcceptedRun("timeout") : undefined,
      );
    } finally {
      entry?.release();
    }
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
    options.assertContextCurrent?.();
    const context = options.getContext();
    const entry = context.requestEntryLifetime?.enter({
      req: { method, params },
      client: options.client,
      context,
    });
    try {
      const methodRegistry = getMethodRegistry();
      const authorization = await authorizeGatewayRequestPreDispatch({
        method,
        requestParams: params,
        client: options.client,
        context,
        methodRegistry,
      });
      entry?.assertOpen();
      if (authorization.error) {
        return throwEnvelopeRejection(method, authorization.error);
      }
      const validationError = validateGatewayMethodParams(params, validateAgentWaitParams, method);
      if (validationError) {
        return throwEnvelopeRejection(method, validationError);
      }
      options.assertContextCurrent?.();
      const result = runWithGatewayRequestEnvelope(
        method,
        options.client,
        () => {
          entry?.assertOpen();
          entry?.release();
          return createAgentTurnService({ context, isWebchatConnect }).waitForTurn(params);
        },
        {
          context,
          isWebchatConnect,
          methodRegistry,
          reject: (error) => throwEnvelopeRejection(method, error),
        },
      );
      return (await waitForGatewayDispatch(method, result, timeoutMs, signal, onSignalAbort)) as T;
    } finally {
      entry?.release();
    }
  };

  return { dispatch, dispatchRaw, wait };
}
