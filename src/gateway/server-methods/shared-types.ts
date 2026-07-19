import type {
  SessionApprovalReplay,
  SystemAgentChatQuestion,
} from "../../../packages/gateway-protocol/src/index.js";
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
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { RuntimePluginToolGrant } from "../../plugins/runtime/tool-grant.js";
import type { SystemAgentOperation } from "../../system-agent/operation-types.js";
import type { WizardSession } from "../../wizard/session.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import type { GatewayHotReloadStatus } from "../config-reload-status.types.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import type { GatewayMethodRegistryView } from "../methods/descriptor.js";
import type { NodeRegistry } from "../node-registry.js";
import type { PluginNodeCapabilitySurface } from "../plugin-node-capability.js";
import type { GatewayBroadcastFn, GatewayBroadcastToConnIdsFn } from "../server-broadcast-types.js";
import type {
  ChannelRuntimeSnapshot,
  StartChannelOptions,
} from "../server-channel-runtime.types.js";
import type {
  BufferedAgentEvent,
  ChatAbortMarker,
  ChatRunEntry,
  ChatRunPlanSnapshot,
  ChatRunRegistration,
} from "../server-chat-state.js";
import type { GatewayCronServiceContract } from "../server-cron-contract.js";
import type {
  GatewayApprovalEventPublisher,
  GatewayRecoveryRuntime,
} from "../server-instance-runtime.types.js";
import type { DedupeEntry } from "../server-shared.js";
import type { GatewayEventLoopHealth } from "../server/event-loop-health.js";
import type { TerminalLaunchResolution } from "../terminal/launch.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import type { WorkerSessionPlacementReader } from "../worker-environments/placement-projector.js";
import type {
  WorkerEnvironmentServiceContract,
  WorkerPlacementDispatchContract,
} from "../worker-environments/service-contract.js";

/**
 * Shared gateway request types used by every server-method module.
 */
type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

/** Per-connection client metadata captured after the gateway handshake. */
export type GatewayClient = {
  connect: ConnectParams;
  connId?: string;
  clientIp?: string;
  /** Client id verified against the server-approved device pairing record. */
  pairedClientId?: string;
  authenticatedUserId?: string;
  authenticatedUserProfile?: {
    profileId: string;
    displayName: string | null;
    hasAvatar: boolean;
  };
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
    /** Host-owned exact media set for a scoped automatic recovery delivery. */
    internalDeliveryMediaUrls?: string[];
    internalDeliverySuppressText?: boolean;
    /** Plugin-owned tools authorized for this internal subagent run. */
    runtimePluginToolGrant?: RuntimePluginToolGrant;
  };
};

/** Callback used by method handlers to emit one protocol response frame. */
export type RespondFn = (
  ok: boolean,
  payload?: unknown,
  error?: ErrorShape,
  meta?: Record<string, unknown>,
) => void;

/** Minimal hosted OpenClaw contract retained by the gateway request router. */
type GatewaySystemAgentSession = {
  engine: {
    handle: (message: string) => Promise<{
      text: string;
      action: "none" | "exit" | "open-tui" | "open-setup";
      sensitive?: boolean;
      question?: SystemAgentChatQuestion;
    }>;
    getPendingOperatorProposal: () => { operation: SystemAgentOperation; hash: string } | null;
    resolveOperatorApproval: (
      decision: "allow-once" | "allow-always" | "deny" | null,
      proposalHash: string,
    ) => Promise<unknown>;
    dispose: () => Promise<void>;
  };
  welcome: string;
  welcomeQuestion?: SystemAgentChatQuestion;
  lastUsedAt: number;
  delegationKey?: string;
  pendingApproval?: { id: string; proposalHash: string };
};

/** Runtime services and mutable gateway state available to request handlers. */
export type GatewayRequestContext = {
  deps: CliDeps;
  cron: GatewayCronServiceContract;
  cronStorePath: string;
  getRuntimeConfig: () => OpenClawConfig;
  notifyPluginMetadataChanged: () => void;
  getMcpAppSandboxPort?: () => number | undefined;
  resolveTerminalLaunchPolicy: (agentId?: string) => TerminalLaunchResolution;
  isTerminalEnabled: () => boolean;
  execApprovalManager?: ExecApprovalManager;
  /** Cancels durable approvals owned by one actively aborted run. */
  cancelRunBoundApprovals?: (runId: string) => number;
  pluginApprovalManager?: ExecApprovalManager<PluginApprovalRequestPayload>;
  systemAgentApprovalManager?: ExecApprovalManager<SystemAgentApprovalRequestPayload>;
  forwardPluginApprovalRequest?: (request: PluginApprovalRequest) => Promise<boolean>;
  pluginApprovalIosPushDelivery?: {
    handleRequested?: (
      request: PluginApprovalRequest,
      opts?: {
        isTargetVisible?: (target: { deviceId: string; scopes: readonly string[] }) => boolean;
      },
    ) => Promise<boolean>;
    handleExpired?: (request: PluginApprovalRequest) => Promise<void>;
  };
  listSessionPendingApprovals?: (
    sessionKey: string,
    client: GatewayClient | null,
  ) => SessionApprovalReplay;
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
  isConnectionActive?: (connId: string) => boolean;
  hasExecApprovalClients?: (excludeConnId?: string) => boolean;
  /** Instance-local native approval subscribers; never derived from a network client. */
  approvalEvents?: GatewayApprovalEventPublisher;
  recoveryRuntime?: GatewayRecoveryRuntime;
  getApprovalClientConnIds?: <TPayload>(params?: {
    approvalKind?: "exec" | "plugin" | "system-agent";
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
  /** Durable per-session worker placement; absent when cloud workers are disabled. */
  workerSessionPlacementService?: WorkerSessionPlacementReader;
  /** One-way local-to-worker dispatch; absent when cloud workers are disabled. */
  workerPlacementDispatchService?: WorkerPlacementDispatchContract;
  // Operator terminal session store. Absent in local/in-process contexts where
  // no PTY surface is served.
  terminalSessions?: TerminalSessionManager;
  agentRunSeq: Map<string, number>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  /** Cancel identities for turns waiting in the followup/collect queue. */
  chatQueuedTurns: Map<string, import("../chat-queued-turns.js").QueuedChatTurnEntry>;
  chatAbortedRuns: Map<string, ChatAbortMarker>;
  chatRunBuffers: Map<string, string>;
  chatRunPlanSnapshots?: Map<string, ChatRunPlanSnapshot>;
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
  subscribeSessionMessageEvents: (
    connId: string,
    sessionKey: string,
    opts?: { includeApprovals?: boolean },
  ) => (() => void) | undefined;
  unsubscribeSessionMessageEvents: (connId: string, sessionKey: string) => void;
  unsubscribeAllSessionEvents: (connId: string) => void;
  getSessionEventSubscriberConnIds: () => ReadonlySet<string>;
  registerToolEventRecipient: (runId: string, connId: string) => void;
  dedupe: Map<string, DedupeEntry>;
  wizardSessions: Map<string, WizardSession>;
  systemAgentSessions: Map<string, GatewaySystemAgentSession>;
  findRunningWizard: () => string | null;
  purgeWizardSession: (id: string) => void;
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
  getConfigReloaderHotReloadStatus?: () => GatewayHotReloadStatus | undefined;
  startChannel: (
    channel: import("../../channels/plugins/types.public.js").ChannelId,
    accountId?: string,
    opts?: StartChannelOptions,
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
  channelWizardRunner: import("./wizard.js").ChannelSetupWizardRunner;
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
