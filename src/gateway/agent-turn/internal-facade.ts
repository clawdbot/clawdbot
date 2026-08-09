import type { AgentWaitParams, ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayMethodRegistry } from "../methods/registry.js";
import {
  waitForGatewayDispatch,
  unwrapGatewayMethodDispatchResponse,
} from "../server-in-process-dispatch.js";
import { runWithGatewayRequestEnvelope } from "../server-methods.js";
import { prepareAgentRequestPreflight } from "../server-methods/agent-request-preflight.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import type { GatewayRequestOptions } from "../server-methods/types.js";
import { createAgentTurnService } from "./agent-turn-service.js";
import { captureAgentTurnPrincipal } from "./principal.js";
import type { AgentTurnFrame, AgentTurnIo } from "./types.js";

type InternalAgentTurnFacadeOptions = {
  client: NonNullable<GatewayRequestOptions["client"]>;
  getContext: () => GatewayRequestOptions["context"];
  getMethodRegistry: () => GatewayMethodRegistry;
  isWebchatConnect?: GatewayRequestOptions["isWebchatConnect"];
};

function unwrapAgentTurnFrame(method: string, frame: AgentTurnFrame): unknown {
  const [ok, payload, error] = frame;
  return unwrapGatewayMethodDispatchResponse(method, { ok, payload, error });
}

function throwEnvelopeRejection(method: string, error: ErrorShape): never {
  return unwrapGatewayMethodDispatchResponse(method, {
    ok: false,
    error,
  }) as never;
}

/** Typed, frame-free access to agent turns owned by the running Gateway instance. */
export function createInternalAgentTurnFacade(options: InternalAgentTurnFacadeOptions) {
  const isWebchatConnect = options.isWebchatConnect ?? (() => false);

  const dispatch = async <T = unknown>(
    request: AgentRunRequest,
    timeoutMs?: number,
  ): Promise<T> => {
    const method = "agent";
    const context = options.getContext();
    const methodRegistry = options.getMethodRegistry();
    let acceptance: AgentTurnFrame | undefined;
    const io: AgentTurnIo = {
      emitAcceptance: (frame) => {
        acceptance ??= frame;
      },
      // Recovery consumes only acceptance; terminal state remains available through wait.
      emitFinal: () => {},
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
        await createAgentTurnService({ context, isWebchatConnect }).startTurn({
          preflight,
          principal,
          io,
        });
      },
      {
        context,
        isWebchatConnect,
        methodRegistry,
        reject: (error) => io.emitAcceptance([false, undefined, error]),
      },
    );
    const response = operation.then(
      () => {
        if (!acceptance) {
          throw new Error(`Gateway method "${method}" completed without a response.`);
        }
        return acceptance;
      },
      (error: unknown) => {
        if (acceptance) {
          return acceptance;
        }
        throw error;
      },
    );
    return unwrapAgentTurnFrame(
      method,
      await waitForGatewayDispatch(method, response, timeoutMs),
    ) as T;
  };

  const wait = async <T = unknown>(params: AgentWaitParams, timeoutMs?: number): Promise<T> => {
    const method = "agent.wait";
    const context = options.getContext();
    const result = runWithGatewayRequestEnvelope(
      method,
      options.client,
      () => createAgentTurnService({ context, isWebchatConnect }).waitForTurn(params),
      {
        context,
        isWebchatConnect,
        methodRegistry: options.getMethodRegistry(),
        reject: (error) => throwEnvelopeRejection(method, error),
      },
    );
    return (await waitForGatewayDispatch(method, result, timeoutMs)) as T;
  };

  return { dispatch, wait };
}
