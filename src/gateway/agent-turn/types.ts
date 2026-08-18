import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../server-methods/shared-types.js";

export type AgentTurnFrame = readonly [
  ok: Parameters<RespondFn>[0],
  payload: Parameters<RespondFn>[1],
  error: Parameters<RespondFn>[2],
];

type AgentTurnAcceptance = AgentTurnFrame;
type AgentTurnFinal = AgentTurnFrame;

export type AgentTurnIo = {
  emitAcceptance: (acceptance: AgentTurnAcceptance, meta?: Parameters<RespondFn>[3]) => void;
  emitFinal: (final: AgentTurnFinal, meta?: Parameters<RespondFn>[3]) => void;
};

export type AgentTurnPrincipal = Pick<
  GatewayClient,
  | "authenticatedUserId"
  | "authenticatedUserProfile"
  | "connId"
  | "connect"
  | "internal"
  | "isDeviceTokenAuth"
>;

export type AgentTurnContext = Pick<
  GatewayRequestContext,
  | "addChatRun"
  | "broadcastToConnIds"
  | "chatAbortControllers"
  | "chatQueuedTurns"
  | "dedupe"
  | "deps"
  | "getRuntimeConfig"
  | "getSessionEventSubscriberConnIds"
  | "loadGatewayModelCatalog"
  | "loadGatewayModelCatalogSnapshot"
  | "logGateway"
  | "recoveryRuntime"
  | "validateAgentRuntimeApprovalAuthority"
>;
