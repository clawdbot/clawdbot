import type { ChatAbortControllerEntry } from "../chat-abort.js";
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
  /** Publishes the exact controller before asynchronous runtime preparation. */
  emitStartOwner?: (runId: string, entry: ChatAbortControllerEntry) => void;
  /** Internal lifecycle observer; public transports do not expose this callback. */
  emitExecutionStarted?: () => void;
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
  | "agentRunSeq"
  | "broadcast"
  | "broadcastToConnIds"
  | "cancelRunBoundApprovals"
  | "chatAbortControllers"
  | "chatQueuedTurns"
  | "chatRunState"
  | "dedupe"
  | "deps"
  | "getRuntimeConfig"
  | "getSessionEventSubscriberConnIds"
  | "loadGatewayModelCatalog"
  | "loadGatewayModelCatalogSnapshot"
  | "logGateway"
  | "nodeSendToSession"
  | "removeChatRun"
  | "requestEntryLifetime"
  | "resolveGatewayContext"
  | "validateAgentRuntimeApprovalAuthority"
>;
