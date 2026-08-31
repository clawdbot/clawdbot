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
import type { AgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import type {
  PluginApprovalRequest,
  PluginApprovalRequestPayload,
} from "../../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRuntimeCore } from "../../plugins/runtime/types-core.js";
import type { SystemAgentOperation } from "../../system-agent/operation-types.js";
import type { WizardSession } from "../../wizard/session.js";
import type { AgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import type { InternalAgentTurnFacadeFactory } from "../agent-turn/internal-facade.types.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import type { GatewayHotReloadStatus } from "../config-reload-status.types.js";
import type { GatewayConfigRevisionProjector } from "../config-revision-token.js";
import type { ScopeUpgradeCoordinator } from "../device-scope-upgrade.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import type { HealthSummary } from "../health/types.js";
import type { GatewayMethodRegistryView } from "../methods/descriptor.js";
import type { NodeRegistry } from "../node-registry.js";
import type { GatewayOperatorRoleActor } from "../operator-role-actor.js";
import type { GatewayPortalService } from "../portals/portal-service.js";
import type { QuestionManager } from "../question-manager.js";
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
import type {
  GatewayModelCatalogSnapshot,
  PreparedGatewayModelCatalog,
} from "../server-model-catalog.types.js";
import type { DedupeEntry } from "../server-shared.js";
import type { GatewayEventLoopHealth } from "../server/event-loop-health.js";
import type { SessionObserverService } from "../session-observer-contract.js";
import type { TerminalLaunchResolution } from "../terminal/launch.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import type {
  WorkerPlacementDiskSpaceReader,
  WorkerPlacementRunnerAvailabilityReader,
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
import type { GatewayClient } from "./client-types.js";

/**
 * Shared gateway request types used by every server-method module.
 */
type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type {
  GatewayAgentRunTaskOwner,
  GatewayClient,
  GatewayNodeInvokeStream,
  TrustedAgentToolCaller,
} from "./client-types.js";

/** Host-minted role authority; leaf contract re-exported for method handlers. */
export type { GatewayOperatorRoleActor };

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
    decorateRejoinReply: (reply: { text: string; action: "none" }) => {
      text: string;
      action: "none" | "exit" | "open-tui" | "open-setup";
      sensitive?: boolean;
      wizardInputPending?: boolean;
      question?: SystemAgentChatQuestion;
      step?: import("../../wizard/session.js").WizardStep;
    };
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
  /** Host-bound plugin ingress; the transport owns its shared hook dispatch queue. */
  dispatchHookAgentTurn?: (
    pluginId: string,
    params: Parameters<PluginRuntimeCore["hooks"]["dispatchHookAgentTurn"]>[0],
  ) => ReturnType<PluginRuntimeCore["hooks"]["dispatchHookAgentTurn"]>;
  configRevisionProjector: GatewayConfigRevisionProjector;
  cron: GatewayCronServiceContract;
  cronStorePath: string;
  getRuntimeConfig: () => OpenClawConfig;
  /** Live reload owner, including same-config restart work and shutdown. */
  isConfigReloadSettled: () => boolean;
  /** Prepared listener certificate pin; undefined when Gateway TLS is disabled. */
  gatewayTlsFingerprint?: string;
  sessionCompanion?: import("../session-companion.js").SessionCompanionService;
  sessionObserver?: SessionObserverService;
  resolveTerminalLaunchPolicy: (agentId?: string) => TerminalLaunchResolution;
  isTerminalEnabled: () => boolean;
  execApprovalManager?: ExecApprovalManager;
  questionManager?: QuestionManager;
  scopeUpgradeCoordinator?: ScopeUpgradeCoordinator;
  /** Exact authority cancels bound approvals; legacy run ids cancel only unbound exec requests. */
  cancelRunBoundApprovals?: (target: string | AgentRunDelegatedAuthority) => number;
  pluginApprovalManager?: ExecApprovalManager<PluginApprovalRequestPayload>;
  systemAgentApprovalManager?: ExecApprovalManager<SystemAgentApprovalRequestPayload>;
  forwardPluginApprovalRequest?: (request: PluginApprovalRequest) => Promise<boolean>;
  approvalWebPushDelivery?: {
    handleRequested: <TPayload>(record: ExecApprovalRecord<TPayload>) => boolean | Promise<boolean>;
    handleResolved: (resolved: { id: string }) => Promise<void>;
    handleExpired: (request: { id: string }) => Promise<void>;
  };
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
  }) => Promise<PreparedGatewayModelCatalog | undefined>;
  readChatMetadata: (params: ChatMetadataReadParams) => Promise<ChatMetadataResult>;
  readChatStartupProjection?: (
    params: ChatStartupProjectionReadParams,
  ) => Promise<ChatStartupProjectionResult | undefined>;
  getHealthCache: () => HealthSummary | null;
  logHealth: { error: (message: string) => void };
  logGateway: SubsystemLogger;
  incrementPresenceVersion: () => number;
  getHealthVersion: () => number;
  /** Instance-local native approval subscribers; never derived from a network client. */
  approvalEvents?: GatewayApprovalEventPublisher;
  recoveryRuntime?: GatewayRecoveryRuntime;
  /** Uses the lifecycle owner's module graph for plugin and detached agent turns. */
  createAgentTurnFacade?: InternalAgentTurnFacadeFactory;
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
  getClientConnIds?: (filter?: (client: GatewayClient) => boolean) => ReadonlySet<string>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  nodeSubscribe: (nodeId: string, sessionKey: string, connId?: string) => void;
  nodeUnsubscribe: (nodeId: string, sessionKey: string, connId?: string) => void;
  nodeUnsubscribeAll: (nodeId: string) => void;
  hasConnectedTalkNode: () => Promise<boolean>;
  isConnectionActive?: (connId: string) => boolean;
  /** Server-stamped activity from an accepted request on the exact live person connection. */
  recordClientActivity?: (client: GatewayClient | null) => void;
  hasExecApprovalClients?: (excludeConnId?: string) => boolean;
  getApprovalClientConnIds?: <TPayload>(params?: {
    approvalKind?: "exec" | "plugin" | "system-agent";
    excludeConnId?: string;
    filter?: (client: GatewayClient, record?: ExecApprovalRecord<TPayload>) => boolean;
    record?: ExecApprovalRecord<TPayload>;
  }) => ReadonlySet<string>;
  disconnectClientsForDevice?: (deviceId: string, opts?: { role?: string }) => void;
  disconnectClientsForUserProfile?: (profileId: string) => void;
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
  registerToolEventRecipient: (runId: string, connId: string) => void;
};

/** Resident-owned services bridged into request handling by the server lifecycle. */
type GatewayResidentBridgeContext = {
  getGatewayMethodRegistry?: () => import("../methods/registry.js").GatewayMethodRegistry;
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
  /** Process-current paired-device runner proof for active placement projection. */
  workerPlacementRunnerAvailabilityReader?: WorkerPlacementRunnerAvailabilityReader;
  /** Use-time approval authority validation over the live run/worker owners. */
  validateAgentRuntimeApprovalAuthority?: AgentRuntimeApprovalAuthorityValidator;
  /** One-way local-to-worker dispatch; absent when cloud workers are disabled. */
  workerPlacementDispatchService?: WorkerPlacementDispatchContract;
  githubPublicationService?: import("../github-publication.js").GitHubPublicationCoordinator;
  githubOAuthService?: ReturnType<
    typeof import("../github-oauth-lifecycle.js").createGitHubOAuthLifecycle
  >;
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
export type GatewayContextResolver = () => GatewayRequestContext | undefined;
export type GatewayRequestContext = GatewayKernelContext &
  GatewayTransportContext &
  GatewayResidentBridgeContext & {
    /** Live instance routing only; never authorization or wire state. */
    resolveGatewayContext?: GatewayContextResolver;
  };

/** Full dispatch context for raw request frames before params are normalized. */
export type GatewayRequestOptions = {
  req: RequestFrame;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  respond: RespondFn;
  context: GatewayRequestContext;
  methodRegistry?: GatewayMethodRegistryView;
  /** In-process Gateway lifetime guard composed into durable session mutations. */
  sessionMutationCommitGuard?: () => void;
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
  sessionMutationCommitGuard?: () => void;
  sessionMutationAuthorization?: SessionMutationAuthorization;
  /** In-process caller lifetime; absent for ordinary transport requests. */
  signal?: AbortSignal;
};

/** Single gateway method implementation. */
export type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;

/** Registry fragment keyed by gateway protocol method name. */
export type GatewayRequestHandlers = Record<string, GatewayRequestHandler>;
