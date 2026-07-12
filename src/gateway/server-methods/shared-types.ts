// Shared server-method types define the client, context, response, and handler
// contracts used by every gateway RPC method module.
import type {
  ConnectParams,
  ErrorShape,
  RequestFrame,
} from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { CliDeps } from "../../cli/deps.types.js";
import type { HealthSummary } from "../../commands/health.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  PluginApprovalRequest,
  PluginApprovalRequestPayload,
} from "../../infra/plugin-approvals.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WizardSession } from "../../wizard/session.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import type { GatewayHotReloadStatus } from "../config-reload-status.types.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import type { GatewayMethodRegistryView } from "../methods/descriptor.js";
import type { NodeRegistry } from "../node-registry.js";
import type { PluginNodeCapabilitySurface } from "../plugin-node-capability.js";
import type { GatewayBroadcastFn, GatewayBroadcastToConnIdsFn } from "../server-broadcast-types.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type {
  BufferedAgentEvent,
  ChatAbortMarker,
  ChatRunEntry,
  ChatRunRegistration,
} from "../server-chat-state.js";
import type { GatewayCronServiceContract } from "../server-cron-contract.js";
import type { DedupeEntry } from "../server-shared.js";
import type { GatewayEventLoopHealth } from "../server/event-loop-health.js";
import type { TerminalLaunchResolution } from "../terminal/launch.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import type { WorkerEnvironmentServiceContract } from "../worker-environments/service-contract.js";

/**
 * Shared gateway request types used by every server-method module.
 */
type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

/** Per-connection client metadata captured after the gateway handshake. */
export type GatewayClient = {
  connect: ConnectParams;
  connId?: string;
  clientIp?: string;
  pluginSurfaceUrls?: Record<string, string>;
  pluginNodeCapabilitySurfaces?: Record<string, PluginNodeCapabilitySurface>;
  pluginNodeCapabilities?: Record<string, { capability: string; expiresAtMs: number }>;
  isDeviceTokenAuth?: boolean;
  internal?: {
    allowModelOverride?: boolean;
    approvalRuntime?: boolean;
    cronRunContinuation?: boolean;
    agentRuntimeIdentity?: AgentRuntimeIdentity;
    pluginRuntimeOwnerId?: string;
    agentRunTracking?: "plugin_subagent";
  };
};

/** Callback used by method handlers to emit one protocol response frame. */
export type RespondFn = (
  ok: boolean,
  payload?: unknown,
  error?: ErrorShape,
  meta?: Record<string, unknown>,
) => void;

/** Minimal hosted Crestodian contract retained by the gateway request router. */
type GatewayCrestodianSession = {
  engine: {
    handle: (message: string) => Promise<{
      text: string;
      action: "none" | "exit" | "open-tui" | "open-setup";
      sensitive?: boolean;
    }>;
    dispose: () => Promise<void>;
  };
  welcome: string;
  lastUsedAt: number;
};

/** Runtime services and mutable gateway state available to request handlers. */
export type GatewayRequestContext = {
  deps: CliDeps;
  cron: GatewayCronServiceContract;
  cronStorePath: string;
  getRuntimeConfig: () => OpenClawConfig;
  getMcpAppSandboxPort?: () => number | undefined;
  resolveTerminalLaunchPolicy: (agentId?: string) => TerminalLaunchResolution;
  isTerminalEnabled: () => boolean;
  execApprovalManager?: ExecApprovalManager;
  pluginApprovalManager?: ExecApprovalManager<PluginApprovalRequestPayload>;
  forwardPluginApprovalRequest?: (request: PluginApprovalRequest) => Promise<boolean>;
  loadGatewayModelCatalog: (params?: { readOnly?: boolean }) => Promise<ModelCatalogEntry[]>;
  loadGatewayModelCatalogSnapshot: (params?: {
    readOnly?: boolean;
  }) => Promise<ModelCatalogSnapshot>;
  getHealthCache: () => HealthSummary | null;
  refreshHealthSnapshot: (opts?: {
    probe?: boolean;
    includeSensitive?: boolean;
  }) => Promise<HealthSummary>;
  logHealth: { error: (message: string) => void };
  logGateway: SubsystemLogger;
  incrementPresenceVersion: () => number;
  getHealthVersion: () => number;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  nodeSubscribe: (nodeId: string, sessionKey: string) => void;
  nodeUnsubscribe: (nodeId: string, sessionKey: string) => void;
  nodeUnsubscribeAll: (nodeId: string) => void;
  hasConnectedTalkNode: () => boolean;
  hasExecApprovalClients?: (excludeConnId?: string) => boolean;
  getApprovalClientConnIds?: <TPayload>(params?: {
    excludeConnId?: string;
    filter?: (client: GatewayClient, record?: ExecApprovalRecord<TPayload>) => boolean;
    record?: ExecApprovalRecord<TPayload>;
  }) => ReadonlySet<string>;
  disconnectClientsForDevice?: (deviceId: string, opts?: { role?: string }) => void;
  invalidateClientsForDevice?: (
    deviceId: string,
    opts?: { role?: string; reason?: string },
  ) => void;
  hasConnectedClientsForDevice?: (deviceId: string) => boolean;
  disconnectClientsUsingSharedGatewayAuth?: () => void;
  enforceSharedGatewayAuthGenerationForConfigWrite?: (nextConfig: OpenClawConfig) => void;
  nodeRegistry: NodeRegistry;
  /** Durable cloud-worker lifecycle; absent from lightweight in-process contexts. */
  workerEnvironmentService?: WorkerEnvironmentServiceContract;
  // Operator terminal session store. Absent in local/in-process contexts where
  // no PTY surface is served.
  terminalSessions?: TerminalSessionManager;
  agentRunSeq: Map<string, number>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  /** Cancel identities for turns waiting in the followup/collect queue. */
  chatQueuedTurns: Map<string, import("../chat-queued-turns.js").QueuedChatTurnEntry>;
  chatAbortedRuns: Map<string, ChatAbortMarker>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  chatDeltaLastBroadcastText: Map<string, string>;
  agentDeltaSentAt: Map<string, number>;
  bufferedAgentEvents: Map<string, BufferedAgentEvent>;
  clearChatRunState: (runId: string) => void;
  addChatRun: (sessionId: string, entry: ChatRunRegistration) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  subscribeSessionEvents: (connId: string) => void;
  unsubscribeSessionEvents: (connId: string) => void;
  subscribeSessionMessageEvents: (connId: string, sessionKey: string) => void;
  unsubscribeSessionMessageEvents: (connId: string, sessionKey: string) => void;
  unsubscribeAllSessionEvents: (connId: string) => void;
  getSessionEventSubscriberConnIds: () => ReadonlySet<string>;
  registerToolEventRecipient: (runId: string, connId: string) => void;
  dedupe: Map<string, DedupeEntry>;
  wizardSessions: Map<string, WizardSession>;
  crestodianSessions: Map<string, GatewayCrestodianSession>;
  findRunningWizard: () => string | null;
  purgeWizardSession: (id: string) => void;
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
  getConfigReloaderHotReloadStatus?: () => GatewayHotReloadStatus | undefined;
  startChannel: (
    channel: import("../../channels/plugins/types.public.js").ChannelId,
    accountId?: string,
    opts?: import("../server-channels.js").StartChannelOptions,
  ) => Promise<void>;
  stopChannel: (
    channel: import("../../channels/plugins/types.public.js").ChannelId,
    accountId?: string,
  ) => Promise<void>;
  markChannelLoggedOut: (
    channelId: import("../../channels/plugins/types.public.js").ChannelId,
    cleared: boolean,
    accountId?: string,
  ) => void;
  wizardRunner: (
    opts: import("../../commands/onboard-types.js").OnboardOptions,
    runtime: import("../../runtime.js").RuntimeEnv,
    prompter: import("../../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
  broadcastVoiceWakeChanged: (triggers: string[]) => void;
  broadcastVoiceWakeRoutingChanged: (
    config: import("../../infra/voicewake-routing.js").VoiceWakeRoutingConfig,
  ) => void;
  unavailableGatewayMethods?: ReadonlySet<string>;
};

/** Full dispatch context for raw request frames before params are normalized. */
export type GatewayRequestOptions = {
  req: RequestFrame;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  respond: RespondFn;
  context: GatewayRequestContext;
  methodRegistry?: GatewayMethodRegistryView;
};

/** Normalized method invocation options passed to registered handlers. */
export type GatewayRequestHandlerOptions = {
  req: RequestFrame;
  params: Record<string, unknown>;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  respond: RespondFn;
  context: GatewayRequestContext;
};

/** Single gateway method implementation. */
export type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;

/** Registry fragment keyed by gateway protocol method name. */
export type GatewayRequestHandlers = Record<string, GatewayRequestHandler>;
