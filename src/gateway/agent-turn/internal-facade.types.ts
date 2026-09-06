import type { AgentWaitParams } from "../../../packages/gateway-protocol/src/index.js";
import type { ConnectParams } from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { GatewayMethodDispatchResponse } from "../server-in-process-dispatch.types.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import type { GatewayClient } from "../server-methods/client-types.js";

export type InternalAgentTurnPrincipalOptions = {
  // Authorization can await; the lifecycle owner must still be current before dispatch.
  assertContextCurrent?: () => void;
  client: GatewayClient;
  isWebchatConnect?: (params: ConnectParams | null | undefined) => boolean;
};

export type AgentTurnStartOwner = {
  observe: () => { executionStarted: boolean; expiresAtMs: number } | undefined;
  abort: () => boolean;
};

export type InternalAgentTurnDispatchOptions = {
  // The source owns admission only; accepted children execute under their own lifetime.
  assertAdmissionCurrent?: () => void;
  cancelOnDeadline?: boolean;
  expectFinal?: boolean;
  onAccepted?: (payload: unknown) => void;
  onStartOwner?: (owner: AgentTurnStartOwner) => void;
  onExecutionStarted?: () => void;
  onSignalAbort?: () => Promise<void> | void;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type InternalAgentTurnFacade = {
  dispatch: <T = unknown>(
    request: AgentRunRequest,
    options?: InternalAgentTurnDispatchOptions | number,
  ) => Promise<T>;
  dispatchRaw: (
    request: AgentRunRequest,
    options?: InternalAgentTurnDispatchOptions,
  ) => Promise<GatewayMethodDispatchResponse>;
  wait: <T = unknown>(
    params: AgentWaitParams,
    timeoutMs?: number,
    signal?: AbortSignal,
    onSignalAbort?: () => Promise<void> | void,
  ) => Promise<T>;
};

export type InternalAgentTurnFacadeFactory = (
  principal: InternalAgentTurnPrincipalOptions,
) => InternalAgentTurnFacade | Promise<InternalAgentTurnFacade>;
