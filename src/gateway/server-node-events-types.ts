// Gateway node event types.
// Defines the narrowed context and event envelope for node-originated handlers.
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { HealthSummary } from "../commands/health.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { ChatAbortMarker, ChatRunEntry, ChatRunRegistration } from "./server-chat.js";
import type { DedupeEntry } from "./server-shared.js";

/** Runtime context available to node event handlers. */
export type NodeEventContext = {
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  nodeSubscribe: (nodeId: string, sessionKey: string) => void;
  nodeUnsubscribe: (nodeId: string, sessionKey: string) => void;
  broadcastVoiceWakeChanged: (triggers: string[]) => void;
  addChatRun: (sessionId: string, entry: ChatRunRegistration) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatAbortedRuns: Map<string, ChatAbortMarker>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  agentRunSeq: Map<string, number>;
  getHealthCache: () => HealthSummary | null;
  refreshHealthSnapshot: (opts?: {
    probe?: boolean;
    includeSensitive?: boolean;
  }) => Promise<HealthSummary>;
  loadGatewayModelCatalog: () => Promise<ModelCatalogEntry[]>;
  authorizeNodeSystemRunEvent: (params: {
    nodeId: string;
    connId?: string;
    runId?: string;
    sessionKey: string;
    terminal: boolean;
  }) => boolean;
  updateNodePresenceActivity?: (params: {
    nodeId: string;
    connId?: string;
    idleSeconds: number;
    saturated?: boolean;
  }) => { lastActiveAtMs: number; presenceUpdatedAtMs: number } | null;
  logGateway: { warn: (msg: string) => void };
};

/** Raw event envelope received from connected node clients. */
export type NodeEvent = {
  event: string;
  payloadJSON?: string | null;
};
