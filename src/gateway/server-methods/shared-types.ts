import type {
  SessionApprovalReplay,
  SystemAgentChatQuestion,
  SystemAgentWizardCancel,
  WizardAnswer,
} from "../../../packages/gateway-protocol/src/index.js";
// Shared server-method types define the client, context, response, and handler
// contracts used by every gateway RPC method module.
import type {
  ConnectParams,
  ErrorShape,
  RequestFrame,
} from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { CliDeps } from "../../cli/deps.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  PluginApprovalRequest,
  PluginApprovalRequestPayload,
} from "../../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginSubagentRequesterContext } from "../../plugins/runtime/subagent-requester-context.js";
import type { RuntimePluginToolGrant } from "../../plugins/runtime/tool-grant.js";
import type { SystemAgentOperation } from "../../system-agent/operation-types.js";
import type { WizardSession } from "../../wizard/session.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { AgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import type { GatewayHotReloadStatus } from "../config-reload-status.types.js";
import type { ScopeUpgradeCoordinator } from "../device-scope-upgrade.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import type { HealthSummary } from "../health/types.js";
import type { GatewayMethodRegistryView } from "../methods/descriptor.js";
import type { NodeRegistry } from "../node-registry.js";
import type { PluginNodeCapabilitySurface } from "../plugin-node-capability.js";
import type { GatewayPortalService } from "../portals/portal-service.js";
import type { GatewayBroadcastFn, GatewayBroadcastToConnIdsFn } from "../server-broadcast-types.js";
import type {
  ChannelRuntimeSnapshot,
  StartChannelOptions,
} from "../server-channel-runtime.types.js";
import type { ChatRunEntry, ChatRunRegistration, ChatRunState } from "../server-chat-state.js";
import type { GatewayCronServiceContract } from "../server-cron-contract.js";
import type {
  GatewayApprovalEventPublisher,
  GatewayRecoveryRuntime,
} from "../server-instance-runtime.types.js";
import type { GatewayModelCatalogSnapshot } from "../server-model-catalog.types.js";
import type { DedupeEntry } from "../server-shared.js";
import type { GatewayEventLoopHealth } from "../server/event-loop-health.js";
import type { SessionObserverService } from "../session-observer-contract.js";
import type { TerminalLaunchResolution } from "../terminal/launch.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import type {
  WorkerPlacementDiskSpaceReader,
  WorkerSessionPlacementReader,
} from "../worker-environments/placement-projector.js";
import type { WorkerSessionPlacementRetirementService } from "../worker-environments/placement-store.js";
import type {
  WorkerEnvironmentServiceContract,
  WorkerPlacementDispatchContract,
} from "../worker-environments/service-contract.js";
import type { ChatMetadataReadParams, ChatMetadataResult } from "./chat-metadata-contract.js";
import type {
  ChatStartupProjectionReadParams,
  ChatStartupProjectionResult,
} from "./chat-startup-projection-contract.js";
import type { TrustedSessionCreation } from "./session-creation-provenance.js";

/**
 * Shared gateway request types used by every server-method module.
 */
type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

/** Trusted in-process spawn control plane that already owns this run's task row.
    Gateway CLI tracking only covers runs nobody else records, so a marked run
    must never get a second row. */
export type GatewayAgentRunTaskOwner = "plugin_subagent" | "native_subagent";

/** Per-connection client metadata captured after the gateway handshake. */
export type GatewayClient = {
  connect: ConnectParams;
  connId?: string;
  presenceKey?: string;
  clientIp?: string;
  /** Client id verified against the server-approved device pairing record. */
  pairedClientId?: string;
  authenticatedUserId?: string;
  /** Verified Tailscale provider identity; generic proxy identities must not infer this. */
  authenticatedUserIsTailscaleProvider?: boolean;
  authenticatedUserProfile?: {
    profileId: string;
    displayName: string | null;
    avatarRevision?: string;
    hasAvatar: boolean;
    updatedAt: number;
  };
  pluginSurfaceUrls?: Record<string, string>;
  pluginNodeCapabilitySurfaces?: Record<string, PluginNodeCapabilitySurface>;
  pluginNodeCapabilities?: Record<string, { capability: string; expiresAtMs: number }>;
  isDeviceTokenAuth?: boolean;
  internal?: {
    /** Handshake-attested direct-local transport; never accepted from wire params. */
    isLocalClient?: true;
    /** Marks the server-constructed client used by trusted in-process dispatch. */
    syntheticClient?: true;
    /** Overrides persisted sender attribution without changing the authorizing client identity. */
    senderAttribution?: { id: string; name?: string };
    /** Trusted session creation provenance; never accepted from Gateway wire params. */
    sessionCreation?: TrustedSessionCreation;
    allowModelOverride?: boolean;
    approvalRuntime?: boolean;
    cronRunContinuation?: boolean;
    agentRuntimeIdentity?: AgentRuntimeIdentity;
    pluginRuntimeOwnerId?: string;
    agentRunTracking?: GatewayAgentRunTaskOwner;
    /** Host-captured requester lineage for opt-in plugin subagent completion delivery. */
    pluginSubagentRequester?: PluginSubagentRequesterContext;
    /** Host-owned exact media set for a scoped automatic recovery delivery. */
    internalDeliveryMediaUrls?: string[];
    internalDeliverySuppressText?: boolean;
    /** Plugin-owned tools authorized for this internal subagent run. */
    runtimePluginToolGrant?: RuntimePluginToolGrant;
    /** Opaque in-process subagent-completion capability; never accepted from wire params. */
    delegatedToolPolicyHandoffId?: string;
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
/**
 * Structural mirror of the engine's SystemAgentAssistantTurn. Kept local as a
 * leaf contract: importing the assistant module here closes a madge cycle
 * through the agents/config cluster.
 */
type SystemAgentHistoryTurn = {
  role: "user" | "assistant";
  text: string;
};

type GatewaySystemAgentSession = {
  engine: {
    handle: (
      message: string,
      options?: { uiContext?: { page: string } },
    ) => Promise<{
      text: string;
      action: "none" | "exit" | "open-tui" | "open-setup";
      sensitive?: boolean;
      question?: SystemAgentChatQuestion;
    }>;
    answerWizard: (answer: WizardAnswer) => Promise<{
      text: string;
      action: "none" | "exit" | "open-tui" | "open-setup";
      sensitive?: boolean;
      question?: SystemAgentChatQuestion;
    }>;
    cancelWizard: (cancel: SystemAgentWizardCancel) => Promise<{
      text: string;
      action: "none" | "exit" | "open-tui" | "open-setup";
      sensitive?: boolean;
      question?: SystemAgentChatQuestion;
    }>;
    seedHistory: (turns: readonly SystemAgentHistoryTurn[]) => void;
    historyLength: () => number;
    historySince: (index: number) => SystemAgentHistoryTurn[];
    getPendingOperatorProposal: () => { operation: SystemAgentOperation; hash: string } | null;
    resolveOperatorApproval: (
      decision: "allow-once" | "allow-always" | "deny" | null,
      proposalHash: string,
    ) => Promise<unknown>;
    dispose: () => Promise<void>;
  };
  welcome: string;
  welcomeQuestion?: SystemAgentChatQuestion;
  /** Audit cursor captured with the pending caretaker welcome; cleared after delivery. */
  welcomeAuditSequence?: number;
  lastUsedAt: number;
  ownerKey: string;
  pendingApproval?: { id: string; proposalHash: string };
};

/** Kernel-owned services and state that can be constructed without binding sockets. */
type GatewayKernelContext = {
  deps: CliDeps;
  cron: GatewayCronServiceContract;
  cronStorePath: string;
  getRuntimeConfig: () => OpenClawConfig;
  /** Prepared listener certificate pin; undefined when Gateway TLS is disabled. */
  gatewayTlsFingerprint?: string;
  sessionCompanion?: import("../session-companion.js").SessionCompanionService;
  sessionObserver?: SessionObserverService;
  resolveTerminalLaunchPolicy: (agentId?: string) => TerminalLaunchResolution;
  isTerminalEnabled: () => boolean;
  execApprovalManager?: ExecApprovalManager;
  scopeUpgradeCoordinator?: ScopeUpgradeCoordinator;
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
  loadGatewayModelCatalog: (params?: {
    agentId?: string;
    agentDir?: string;
    readOnly?: boolean;
    workspaceDir?: string;
  }) => Promise<ModelCatalogEntry[]>;
  loadGatewayModelCatalogSnapshot: (params?: {
    agentId?: string;
    agentDir?: string;
    readOnly?: boolean;
    workspaceDir?: string;
  }) => Promise<GatewayModelCatalogSnapshot>;
  readPreparedGatewayModelCatalog?: (params?: {
    agentId?: string;
    agentDir?: string;
    workspaceDir?: string;
  }) => Promise<ModelCatalogEntry[] | undefined>;
  readChatMetadata: (params: ChatMetadataReadParams) => Promise<ChatMetadataResult>;
  readChatStartupProjection?: (
    params: ChatStartupProjectionReadParams,
  ) => Promise<ChatStartupProjectionResult>;
  getHealthCache: () => HealthSummary | null;
  logHealth: { error: (message: string) => void };
  logGateway: SubsystemLogger;
  incrementPresenceVersion: () => number;
  getHealthVersion: () => number;
  /** Instance-local native approval subscribers; never derived from a network client. */
  approvalEvents?: GatewayApprovalEventPublisher;
  recoveryRuntime?: GatewayRecoveryRuntime;
  enforceSharedGatewayAuthGenerationForConfigWrite?: (nextConfig: OpenClawConfig) => void;
  nodeRegistry: NodeRegistry;
  agentRunSeq: Map<string, number>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  /** Cancel identities for turns waiting in the followup/collect queue. */
  chatQueuedTurns: Map<string, import("../chat-queued-turns.js").QueuedChatTurnEntry>;
  chatRunState: ChatRunState;
  addChatRun: (sessionId: string, entry: ChatRunRegistration) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  dedupe: Map<string, DedupeEntry>;
  wizardSessions: Map<string, WizardSession>;
  systemAgentSessions: Map<string, GatewaySystemAgentSession>;
  findRunningWizard: () => string | null;
  purgeWizardSession: (id: string) => void;
  wizardRunner: (
    opts: import("../../commands/onboard-types.js").OnboardOptions,
    runtime: import("../../runtime.js").RuntimeEnv,
    prompter: import("../../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
  channelWizardRunner: import("./wizard.js").ChannelSetupWizardRunner;
  unavailableGatewayMethods?: ReadonlySet<string>;
};

/** Socket-bound services and connection state supplied by the Gateway transports. */
type GatewayTransportContext = {
  portalService?: GatewayPortalService;
  getMcpAppSandboxPort?: () => number | undefined;
  ensureSandboxHostPort?: () => Promise<number>;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  nodeSubscribe: (nodeId: string, sessionKey: string, connId?: string) => void;
  nodeUnsubscribe: (nodeId: string, sessionKey: string, connId?: string) => void;
  nodeUnsubscribeAll: (nodeId: string) => void;
  hasConnectedTalkNode: () => Promise<boolean>;
  isConnectionActive?: (connId: string) => boolean;
  hasExecApprovalClients?: (excludeConnId?: string) => boolean;
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
  refreshConnectedUserProfile?: (profile: {
    id: string;
    displayName: string | null;
    avatarRevision: string;
    hasAvatar: boolean;
    updatedAt: number;
  }) => void;
  disconnectClientsUsingSharedGatewayAuth?: () => void;
  // Operator terminal session store. Absent in local/in-process contexts where
  // no PTY surface is served.
  terminalSessions?: TerminalSessionManager;
  subscribeSessionEvents: (connId: string) => void;
  unsubscribeSessionEvents: (connId: string) => void;
  subscribeSessionMessageEvents: (
    connId: string,
    sessionKey: string,
    opts?: { includeApprovals?: boolean; provisional?: boolean },
  ) => ((() => void) & { commit: () => void }) | undefined;
  unsubscribeSessionMessageEvents: (connId: string, sessionKey: string) => void;
  unsubscribeAllSessionEvents: (connId: string) => void;
  getSessionEventSubscriberConnIds: () => ReadonlySet<string>;
  getSessionMessageSubscriberConnIds?: (sessionKey: string) => ReadonlySet<string>;
  registerToolEventRecipient: (runId: string, connId: string) => void;
};

/** Resident-owned services bridged into request handling by the server lifecycle. */
type GatewayResidentBridgeContext = {
  controlUiSessionPullRequests?: ReturnType<
    typeof import("../control-ui-session-pr-subscriptions.js").createControlUiSessionPullRequestSubscriptions
  >;
  sessionViewerPresence?: ReturnType<
    typeof import("../session-viewer-presence.js").createSessionViewerPresenceDeclarations
  >;
  notifyPluginMetadataChanged: () => void;
  refreshHealthSnapshot: (opts?: {
    probe?: boolean;
    includeSensitive?: boolean;
  }) => Promise<HealthSummary>;
  /** Durable cloud-worker lifecycle; absent from lightweight in-process contexts. */
  workerEnvironmentService?: WorkerEnvironmentServiceContract;
  /** Gateway-host desktop acquisition and observation; present only after enabled startup. */
  hostDesktopService?: import("../desktop/host-source.js").HostDesktopService;
  /** Durable per-session worker placement; absent only from lightweight in-process contexts. */
  workerSessionPlacementService?: WorkerSessionPlacementReader &
    Partial<WorkerSessionPlacementRetirementService>;
  /** Process-local health samples fenced to the exact active placement owner. */
  workerPlacementDiskSpaceReader?: WorkerPlacementDiskSpaceReader;
  /** Use-time approval authority validation over the live run/worker owners. */
  validateAgentRuntimeApprovalAuthority?: AgentRuntimeApprovalAuthorityValidator;
  /** One-way local-to-worker dispatch; absent when cloud workers are disabled. */
  workerPlacementDispatchService?: WorkerPlacementDispatchContract;
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
  broadcastVoiceWakeChanged: (triggers: string[]) => void;
  broadcastVoiceWakeRoutingChanged: (
    config: import("../../infra/voicewake-routing.js").VoiceWakeRoutingConfig,
  ) => void;
};

/** Complete runtime context available to gateway request handlers. */
export type GatewayRequestContext = GatewayKernelContext &
  GatewayTransportContext &
  GatewayResidentBridgeContext;

/** Full dispatch context for raw request frames before params are normalized. */
export type GatewayRequestOptions = {
  req: RequestFrame;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  respond: RespondFn;
  context: GatewayRequestContext;
  methodRegistry?: GatewayMethodRegistryView;
  /** In-process caller lifetime; never serialized into a Gateway request frame. */
  signal?: AbortSignal;
};

/** Commit-time guard captured by the pre-dispatch session participation check. */
export type SessionMutationAuthorization = {
  assertCurrent: () => void;
  assertTargetCurrent: (target: { sessionKey: string; agentId?: string }) => void;
};

/** Normalized method invocation options passed to registered handlers. */
export type GatewayRequestHandlerOptions = {
  req: RequestFrame;
  params: Record<string, unknown>;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  respond: RespondFn;
  context: GatewayRequestContext;
  sessionMutationAuthorization?: SessionMutationAuthorization;
  /** In-process caller lifetime; absent for ordinary transport requests. */
  signal?: AbortSignal;
};

/** Single gateway method implementation. */
export type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;

/** Registry fragment keyed by gateway protocol method name. */
export type GatewayRequestHandlers = Record<string, GatewayRequestHandler>;
