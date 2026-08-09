import type { GatewayClient, GatewayRequestContext } from "../server-methods/shared-types.js";

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
  | "registerToolEventRecipient"
>;
