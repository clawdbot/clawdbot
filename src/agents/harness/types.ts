/**
 * Public native agent harness contracts and capability shapes.
 */
import type {
  ProviderModelRouteAuthRequirement,
  ProviderModelRouteRuntimePolicy,
  ProviderRouteOverridePresence,
} from "../../plugin-sdk/provider-model-types.js";
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
  | { supported: false; reason?: string };

type InternalEmbeddedRunAttemptParams =
  import("../embedded-agent-runner/run/types.js").EmbeddedRunAttemptParams;

export type AgentHarnessAttemptParams = Omit<
  InternalEmbeddedRunAttemptParams,
  "trajectoryRecorder"
>;
export type AgentHarnessAttemptResult =
  import("../embedded-agent-runner/run/types.js").EmbeddedRunAttemptResult;
export type AgentHarnessAuthBindingFingerprintParams = {
  authProfileId: string;
  authProfileStore: import("../auth-profiles/types.js").AuthProfileStore;
  agentDir: string;
  config?: import("../../config/types.openclaw.js").OpenClawConfig;
};
export type AgentHarnessSideQuestionParams = {
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
export type AgentHarnessSideQuestionResult = {
  text: string;
};
export type AgentHarnessCompactParams =
  import("../embedded-agent-runner/compact.types.js").CompactEmbeddedAgentSessionParams;
export type AgentHarnessCompactResult =
  import("../embedded-agent-runner/types.js").EmbeddedAgentCompactResult;
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

type AgentHarnessRunCapability = {
  id: string;
  label: string;
  pluginId?: string;
  /**
   * Exhaustive provider ids eligible for automatic selection. Omitting this hint preserves
   * dynamic probing; an empty list marks an explicit-only harness.
   */
  autoSelection?: { providerIds: readonly string[] };
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
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
  /** Lets this harness resolve forwarded profiles or its own native credentials. */
  authBootstrap?: "harness";
  runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult>;
};

type AgentHarnessSideQuestionCapability = {
  runSideQuestion?(params: AgentHarnessSideQuestionParams): Promise<AgentHarnessSideQuestionResult>;
};

type AgentHarnessClassificationCapability = {
  classify?(
    result: AgentHarnessAttemptResult,
    ctx: AgentHarnessAttemptParams,
  ): AgentHarnessResultClassification | undefined;
};

type AgentHarnessCompactionCapability = {
  compact?(params: AgentHarnessCompactParams): Promise<AgentHarnessCompactResult | undefined>;
};

type AgentHarnessSessionLifecycleCapability = {
  reset?(params: AgentHarnessResetParams): Promise<void> | void;
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

export type AgentHarness = AgentHarnessRunCapability &
  AgentHarnessSideQuestionCapability &
  AgentHarnessClassificationCapability &
  AgentHarnessCompactionCapability &
  AgentHarnessRuntimeArtifactCapability &
  AgentHarnessAuthBindingCapability &
  AgentHarnessProviderUsageCapability &
  AgentHarnessSessionForkCapability &
  AgentHarnessSessionLifecycleCapability;

export type RegisteredAgentHarness = {
  harness: AgentHarness;
  ownerPluginId?: string;
};
