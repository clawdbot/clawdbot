import type { SessionToolOverrides } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
/**
 * Public native agent harness contracts and capability shapes.
 */
import type {
  ProviderModelRouteAuthRequirement,
  ProviderModelRouteRuntimePolicy,
  ProviderRouteOverridePresence,
} from "../../plugin-sdk/provider-model-types.js";
import type { McpToolCatalog } from "../agent-bundle-mcp-types.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import type { AgentHarnessRuntimeArtifactBinding } from "./runtime-artifact.types.js";

export type { AgentHarnessRuntimeArtifactBinding } from "./runtime-artifact.types.js";

export type AgentHarnessPreparedAuthSupport = {
  source: "profile" | "direct" | "harness" | "none";
  mode?: string;
  requirement?: ProviderModelRouteAuthRequirement;
};
export type AgentHarnessSupportContext = {
  provider: string;
  modelId?: string;
  modelProvider?: {
    api?: string;
    baseUrl?: string;
    azureApiVersion?: string;
    /** Secret-free projection of request behavior a native harness must reproduce. */
    requestTransportOverrides?: ProviderRouteOverridePresence;
    /** Provider-owned native-runtime compatibility for the prepared route. */
    runtimePolicy?: ProviderModelRouteRuntimePolicy;
    /** Secret-free auth source the native runtime must reproduce for this attempt. */
    preparedAuth?: AgentHarnessPreparedAuthSupport;
    request?: {
      auth?: { mode?: unknown };
      proxy?: unknown;
      tls?: unknown;
      allowPrivateNetwork?: unknown;
    };
  };
  requestedRuntime: import("../agent-runtime-id.js").EmbeddedAgentRuntime;
  providerOwnerStatus?: "unowned" | "owned" | "ambiguous";
  providerOwnerPluginIds?: readonly string[];
};

export type AgentHarnessSupport =
  | { supported: true; priority?: number; reason?: string }
  | {
      supported: false;
      reason?: string;
      /** Lossless host fallback when this harness cannot reproduce the prepared request. */
      fallbackRuntime?: "openclaw";
    };

type InternalEmbeddedRunAttemptParams =
  import("../embedded-agent-runner/run/types.js").EmbeddedRunAttemptParams;
/** @deprecated Read `terminal` instead. Remove no earlier than the 2026.9 stable release. */
type AgentHarnessDeprecatedAttemptTerminalFields = {
  aborted?: boolean;
  externalAbort?: boolean;
  timedOut?: boolean;
  idleTimedOut?: boolean;
  timedOutDuringCompaction?: boolean;
  timedOutDuringToolExecution?: boolean;
  timedOutByRunBudget?: boolean;
  promptError?: unknown;
  promptErrorSource?:
    | import("../agent-run-terminal-outcome.js").AgentRunAttemptFailureSource
    | null;
};
type AgentHarnessCanonicalAttemptResult = Omit<
  import("../embedded-agent-runner/run/types.js").EmbeddedRunAttemptResult,
  "contextEngineTerminalAnchor"
> &
  AgentHarnessDeprecatedAttemptTerminalFields;

/** @deprecated Return `terminal` instead. Remove no earlier than the 2026.9 stable release. */
type AgentHarnessLegacyAttemptResult = Omit<
  import("../embedded-agent-runner/run/types.js").EmbeddedRunAttemptResult,
  "contextEngineTerminalAnchor" | "terminal"
> &
  AgentHarnessDeprecatedAttemptTerminalFields & {
    aborted: boolean;
    externalAbort: boolean;
    timedOut: boolean;
    idleTimedOut: boolean;
    timedOutDuringCompaction: boolean;
    timedOutDuringToolExecution?: boolean;
    timedOutByRunBudget?: boolean;
    promptError: unknown;
    promptErrorSource:
      | import("../agent-run-terminal-outcome.js").AgentRunAttemptFailureSource
      | null;
  };

type AgentHarnessAttemptParamsBase = Omit<
  InternalEmbeddedRunAttemptParams,
  | "admittedRunContext"
  | "contextEngineLogicalTurnLease"
  | "deferSourceMessageToolDelivery"
  | "onBeforeAgentFinalize"
  | "onContextEngineTurnCandidate"
  | "trajectoryRecorder"
>;
/**
 * @deprecated Use AgentHarnessAttemptParamsV2. The optional capability keeps
 * existing harness source compatible through 2026-10-12.
 */
export type AgentHarnessAttemptParams = AgentHarnessAttemptParamsBase & {
  hostCapabilities?: AgentHarnessHostCapabilities;
};
/** Current host-prepared attempt contract for agent harnesses. */
export type AgentHarnessAttemptParamsV2 = AgentHarnessAttemptParamsBase & {
  hostCapabilities: AgentHarnessHostCapabilities;
};
export type AgentHarnessAttemptResult =
  | AgentHarnessCanonicalAttemptResult
  | AgentHarnessLegacyAttemptResult;
export type AgentHarnessSettledTurnFinalizationAttemptParams<
  TAttemptParams extends AgentHarnessAttemptParams = AgentHarnessAttemptParams,
> = Omit<TAttemptParams, "hostCapabilities"> & { hostCapabilities?: never };
type AgentHarnessSettledTurnFinalizationParams<
  TAttemptParams extends AgentHarnessAttemptParams = AgentHarnessAttemptParams,
> = {
  /** Fully prepared attempt context for the isolated finalization operation. */
  attempt: AgentHarnessSettledTurnFinalizationAttemptParams<TAttemptParams>;
  /** Settled result whose completed tool transcript needs a final visible answer. */
  settledAttempt: AgentHarnessCanonicalAttemptResult;
};
export type AgentHarnessSettledTurnFinalizationResult = {
  /** The single completed assistant answer produced by the isolated operation. */
  assistant: import("../../llm/types.js").AssistantMessage;
  /** Normalized usage for the finalization model call only. */
  usage?: import("../usage.js").NormalizedUsage;
  /** True when the harness already persisted the assistant into the application transcript. */
  assistantTranscriptOwned?: boolean;
  /** Exact idempotency key for the harness-owned assistant transcript row. */
  assistantTranscriptIdempotencyKey?: string;
  /** Assistant stream generation index used to correlate final reply delivery. */
  assistantMessageIndex?: number;
  diagnosticTrace?: import("../../infra/diagnostic-trace-context.js").DiagnosticTraceContext;
};
/** @deprecated Use AgentHarnessIsolatedCompletionParamsV2. Remove after 2026-10-12. */
type AgentHarnessIsolatedCompletionParams = {
  /** Logical provider selected by the caller before harness dispatch. */
  provider: string;
  /** Logical model id selected by the caller before harness dispatch. */
  modelId: string;
  /** Exact prepared transport model; harnesses must not resolve another route. */
  model: import("../../llm/types.js").Model;
  /** Exact prepared credential; harnesses must not rotate or substitute it. */
  auth: import("../model-auth-runtime-shared.js").ResolvedProviderAuth;
  /** Non-reversible proof of the prepared credential owner when available. */
  sourceAuthFingerprint?: string;
  config: import("../../config/types.openclaw.js").OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  thinkLevel?: import("../../auto-reply/thinking.js").ThinkLevel;
  /** Do not recover ambiguous reasoning as visible text; an empty visible result is valid. */
  outputTextPolicy?: "strict-visible";
  streamParams?: {
    maxTokens?: number;
    temperature?: number;
  };
};
export type AgentHarnessIsolatedCompletionAuthorization =
  | {
      /** OpenClaw resolved the exact transport model and credential before handoff. */
      owner: "host";
      model: import("../../llm/types.js").Model;
      auth: import("../model-auth-runtime-shared.js").ResolvedProviderAuth;
      /** Non-reversible proof of the prepared credential owner when available. */
      sourceAuthFingerprint?: string;
    }
  | {
      /** The selected harness owns credential resolution for this prepared route. */
      owner: "harness";
      plan: import("../runtime-plan/types.js").AgentRuntimeAuthPlan;
      /** Credential snapshot restricted to the single profile selected for this call. */
      authProfileStore: import("../auth-profiles/types.js").AuthProfileStore;
    };
export type AgentHarnessIsolatedCompletionParamsV2 = Omit<
  AgentHarnessIsolatedCompletionParams,
  "model" | "auth" | "sourceAuthFingerprint"
> & {
  authorization: AgentHarnessIsolatedCompletionAuthorization;
};
export type AgentHarnessIsolatedCompletionResult = {
  /** The single assistant completion. Core rejects tool-shaped or failed results. */
  assistant: import("../../llm/types.js").AssistantMessage;
};
export type AgentHarnessAuthBindingFingerprintParams = {
  authProfileId: string;
  authProfileStore: import("../auth-profiles/types.js").AuthProfileStore;
  agentDir: string;
  config?: import("../../config/types.openclaw.js").OpenClawConfig;
};
/**
 * @deprecated Use {@link AgentHarnessSideQuestionParamsV2}. This compatibility
 * contract is retained through 2026-10-12.
 */
export type AgentHarnessSideQuestionParams = {
  /** Host-bound authority for this admitted side execution; contains no public token fields. */
  hostCapabilities?: AgentHarnessHostCapabilities;
  /** Host-resolved sandbox snapshot for this side execution. */
  sandbox?: import("../sandbox/types.js").SandboxContext | null;
  /** Prepared plugin/model generation that owns this side execution. */
  preparedModelRuntime?: import("../prepared-model-runtime.types.js").PreparedModelRuntimeSnapshot;
  cfg: import("../../config/types.openclaw.js").OpenClawConfig;
  agentDir: string;
  provider: string;
  model: string;
  runtimeModel?: import("openclaw/plugin-sdk/llm").Model<import("openclaw/plugin-sdk/llm").Api>;
  /** One atomic route/profile/store snapshot prepared before native dispatch. */
  preparedRuntimeAuth: {
    plan: import("../runtime-plan/types.js").AgentRuntimeAuthPlan;
    authProfileStore: import("../auth-profiles/types.js").AuthProfileStore;
    authStorage: import("../sessions/index.js").AuthStorage;
    modelRegistry: import("../sessions/index.js").ModelRegistry;
    /** Resolved host credential for an immutable API-key route only. */
    resolvedApiKey?: string;
  };
  question: string;
  sessionEntry: import("../../config/sessions.js").SessionEntry;
  sessionStore?: Record<string, import("../../config/sessions.js").SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  resolvedThinkLevel?: import("../../auto-reply/thinking.js").ThinkLevel;
  resolvedReasoningLevel: import("../../auto-reply/thinking.js").ReasoningLevel;
  blockReplyChunking?: import("../embedded-agent-block-chunker.js").BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  opts?: import("../../auto-reply/get-reply-options.types.js").GetReplyOptions;
  isNewSession: boolean;
  sessionId: string;
  sessionFile: string;
  sandboxSessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
  messageChannel?: string;
  messageProvider?: string;
  chatType?: import("../../channels/chat-type.js").ChatType;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  chatId?: string;
  messageActionTurnCapability?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  memberRoleIds?: string[];
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  senderIsOwner?: boolean;
  currentChannelId?: string;
  toolsAllow?: string[];
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};
/** Current side-question contract for hosts that always provide closure-bound authority. */
export type AgentHarnessSideQuestionParamsV2 = AgentHarnessSideQuestionParams & {
  hostCapabilities: AgentHarnessHostCapabilities;
};
export type AgentHarnessSideQuestionResult = {
  text: string;
};
export type AgentHarnessCompactParams =
  import("../embedded-agent-runner/compact.types.js").CompactEmbeddedAgentSessionParams;
export type AgentHarnessCompactResult =
  import("../embedded-agent-runner/types.js").EmbeddedAgentCompactResult;
export type AgentHarnessNativeCompactionRequest = "after_context_engine" | "required_preflight";
export type AgentHarnessNativeCompactionParams = AgentHarnessCompactParams & {
  nativeCompactionRequest: AgentHarnessNativeCompactionRequest;
};
export type AgentHarnessNativeCompaction = (
  params: AgentHarnessNativeCompactionParams,
) => Promise<AgentHarnessCompactResult | undefined>;
export type AgentHarnessRegistrationOptions = {
  /**
   * Registers the Codex-only native preflight bridge in host-owned registry
   * metadata. Arbitrary properties on the public harness never grant it.
   */
  nativeCompaction?: AgentHarnessNativeCompaction;
};
export type AgentHarnessResetParams = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  reason?: "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "unknown";
};

export type AgentHarnessSessionForkFailureCode =
  | "steer-message"
  | "in-progress-turn"
  | "drift-mismatch"
  | "upstream-unavailable";

export type AgentHarnessSessionForkParams = {
  targetKey: string;
  /** Creator-owned isolation floor resolved by the trusted Gateway request. */
  sandbox?: "required";
  source: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
    entryId: string;
  };
  upstream: {
    catalogId: string;
    hostId: string;
    kind: import("../../plugins/session-catalog.js").SessionUpstreamKind;
    threadId: string;
    ref: import("../../plugins/session-catalog.js").SessionUpstreamJsonValue;
  };
};

export type AgentHarnessSessionForkResult =
  | {
      status: "created";
      key: string;
      editorText?: string;
    }
  | {
      status: "failed";
      code: AgentHarnessSessionForkFailureCode;
      message: string;
    };

export type AgentHarnessResultClassification =
  | "ok"
  | NonNullable<AgentHarnessAttemptResult["agentHarnessResultClassification"]>;

export type AgentHarnessDeliveryDefaults = {
  /** Default visible-reply policy when config does not override the harness. */
  visibleReplies?: "automatic" | "message_tool";
  /**
   * @deprecated Use visibleReplies. Kept for existing harness plugins.
   */
  sourceVisibleReplies?: "automatic" | "message_tool";
};

/** Exact node authority and worker capacity required by one paired-device runtime. */
export type DevicePlacementRequirement = {
  requiredNodeCommands: readonly string[];
  consumesWorkerSlot: boolean;
};

type AgentHarnessRunCapability<
  TAttemptParams extends AgentHarnessAttemptParams = AgentHarnessAttemptParams,
> = {
  id: string;
  label: string;
  pluginId?: string;
  /**
   * Exhaustive provider ids eligible for automatic selection. Omitting this hint preserves
   * dynamic probing; an empty list marks an explicit-only harness.
   */
  autoSelection?: { providerIds: readonly string[] };
  /** Declares host-owned remote execution and its exact paired-device requirements. */
  cloudPlacement?: { mode: "remote-exec"; devicePlacement?: DevicePlacementRequirement };
  /**
   * Plugin ids this harness owner permits to execute its locked sessions.
   * Delegates receive work admission and execution only; session mutation stays owner-only.
   */
  delegatedExecutionPluginIds?: readonly string[];
  /**
   * Context-engine host capabilities provided by this harness during agent
   * runs. Harnesses that omit this are unsupported for engines that declare
   * host requirements.
   */
  contextEngineHostCapabilities?: readonly import("../../context-engine/types.js").ContextEngineHostCapability[];
  deliveryDefaults?: AgentHarnessDeliveryDefaults;
  /** Certifies exact runAttempt enforcement; direct-policy-restricted channel side questions fail in core. */
  conversationToolPolicySupport?: "exact";
  /**
   * Canonical OpenClaw tool names whose exact denies the harness can also enforce
   * against native equivalents. Every other deny remains fail-closed.
   */
  conversationToolPolicySafeDenyTools?: readonly string[];
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
  /** Lets this harness resolve forwarded profiles or its own native credentials. */
  authBootstrap?: "harness";
  runAttempt(params: TAttemptParams): Promise<AgentHarnessAttemptResult>;
  /**
   * Produces one final answer from a settled tool transcript without exposing
   * capabilities that can repeat or extend the completed work.
   */
  finalizeSettledTurn?(
    params: AgentHarnessSettledTurnFinalizationParams<TAttemptParams>,
  ): Promise<AgentHarnessSettledTurnFinalizationResult>;
  /** @deprecated Implement runIsolatedCompletionV2. Remove after 2026-10-12. */
  runIsolatedCompletion?(
    params: AgentHarnessIsolatedCompletionParams,
  ): Promise<AgentHarnessIsolatedCompletionResult>;
  /**
   * Runs one fresh prompt-only completion with a literal zero-tool model surface.
   * The harness must fail closed when it cannot enforce that native boundary.
   */
  runIsolatedCompletionV2?(
    params: AgentHarnessIsolatedCompletionParamsV2,
  ): Promise<AgentHarnessIsolatedCompletionResult>;
};

type AgentHarnessSideQuestionCapability<
  TSideQuestionParams extends AgentHarnessSideQuestionParams = AgentHarnessSideQuestionParams,
> = {
  runSideQuestion?(params: TSideQuestionParams): Promise<AgentHarnessSideQuestionResult>;
};

type AgentHarnessClassificationCapability<
  TAttemptParams extends AgentHarnessAttemptParams = AgentHarnessAttemptParams,
> = {
  classify?(
    result: AgentHarnessAttemptResult,
    ctx: TAttemptParams,
  ): AgentHarnessResultClassification | undefined;
};

type AgentHarnessCompactionCapability = {
  compact?(params: AgentHarnessCompactParams): Promise<AgentHarnessCompactResult | undefined>;
};

export type AgentHarnessSessionDeletionParams = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  /** Revalidate the captured registry, harness, and operation before each side effect. */
  assertCurrent: () => void;
};

export type AgentHarnessSessionDeletionMutation = {
  /** Synchronously remove only the prepared owner's state at the session commit edge. */
  commit: () => void;
  /** Restore only that removal when the authoritative session transaction rolls back. */
  rollback: () => void;
};

type AgentHarnessSessionLifecycleCapability = {
  reset?(params: AgentHarnessResetParams): Promise<void> | void;
  /** Prepare outside the session writer; release native resources after its commit completes. */
  withSessionDeletion?<T>(
    this: void,
    params: AgentHarnessSessionDeletionParams,
    run: (mutation: AgentHarnessSessionDeletionMutation) => Promise<T>,
  ): Promise<T>;
  dispose?(): Promise<void> | void;
};

type AgentHarnessSessionForkCapability = {
  sessionFork?: {
    upstreamKinds: readonly import("../../plugins/session-catalog.js").SessionUpstreamKind[];
    fork(params: AgentHarnessSessionForkParams): Promise<AgentHarnessSessionForkResult>;
  };
};

type AgentHarnessRuntimeArtifactCapability = {
  /** Revalidate an artifact only at setup and persistent-operation boundaries. */
  runtimeArtifact?: {
    validate(binding: AgentHarnessRuntimeArtifactBinding): Promise<boolean>;
  };
};

type AgentHarnessAuthBindingCapability = {
  /** Recomputes the exact credential fingerprint at persistent trust boundaries. */
  authBinding?: {
    fingerprint(params: AgentHarnessAuthBindingFingerprintParams): Promise<string | undefined>;
  };
};

type AgentHarnessProviderUsageCapability = {
  /**
   * Contributes runtime-owned quota data without registering a text provider.
   * Provider usage hooks remain authoritative when both surfaces exist.
   */
  fetchUsageSnapshot?: (
    ctx: import("../../plugins/provider-runtime.types.js").ProviderFetchUsageSnapshotContext,
  ) =>
    | Promise<
        import("../../infra/provider-usage.types.js").ProviderUsageSnapshot | null | undefined
      >
    | import("../../infra/provider-usage.types.js").ProviderUsageSnapshot
    | null
    | undefined;
};

type AgentHarnessMcpCatalogParams = {
  config: OpenClawConfig;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  workspaceDir: string;
  /** OpenClaw-configured servers whose session policy this harness can enforce. */
  mcpServerNames: readonly string[];
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
};

type AgentHarnessMcpCatalogCapability = {
  /** Lists the MCP tools owned by this session's native runtime, if it is already bound. */
  loadMcpToolCatalog?(params: AgentHarnessMcpCatalogParams): Promise<McpToolCatalog | undefined>;
};

export type AgentHarnessModelCatalogParams = {
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
};

type AgentHarnessModelCatalogCapability = {
  /** Lists account-scoped models owned by this native runtime. */
  loadModelCatalog?(
    params: AgentHarnessModelCatalogParams,
  ): Promise<readonly import("../model-catalog.types.js").ModelCatalogEntry[]>;
  /**
   * Reads current, secret-free native account evidence for this exact catalog scope/model.
   * No I/O or discovery here. Missing/stale/disposed evidence returns undefined; this is
   * picker metadata only, never execution authorization or a host-route credential.
   */
  readModelCatalogReadiness?(
    params: AgentHarnessModelCatalogParams & { provider: string; modelId: string },
  ): { accountType: string } | undefined;
};

/**
 * @deprecated Implement AgentHarnessV2. This registration contract remains
 * source-compatible for existing plugins through 2026-10-12.
 */
export type AgentHarness = AgentHarnessRunCapability &
  AgentHarnessSideQuestionCapability &
  AgentHarnessClassificationCapability &
  AgentHarnessCompactionCapability &
  AgentHarnessRuntimeArtifactCapability &
  AgentHarnessAuthBindingCapability &
  AgentHarnessProviderUsageCapability &
  AgentHarnessModelCatalogCapability &
  AgentHarnessMcpCatalogCapability &
  AgentHarnessSessionForkCapability &
  AgentHarnessSessionLifecycleCapability;

/** Current harness contract for hosts that always supply versioned capabilities. */
export type AgentHarnessV2 = AgentHarnessRunCapability<AgentHarnessAttemptParamsV2> &
  AgentHarnessSideQuestionCapability<AgentHarnessSideQuestionParamsV2> &
  AgentHarnessClassificationCapability<AgentHarnessAttemptParamsV2> &
  AgentHarnessCompactionCapability &
  AgentHarnessRuntimeArtifactCapability &
  AgentHarnessAuthBindingCapability &
  AgentHarnessProviderUsageCapability &
  AgentHarnessModelCatalogCapability &
  AgentHarnessMcpCatalogCapability &
  AgentHarnessSessionForkCapability &
  AgentHarnessSessionLifecycleCapability;

export type RegisteredAgentHarness = {
  harness: AgentHarness;
  ownerPluginId?: string;
};
