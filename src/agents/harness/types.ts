/**
 * Public native agent harness contracts and capability shapes.
 */
export type AgentHarnessSupportContext = {
  provider: string;
  modelId?: string;
  modelProvider?: {
    api?: string;
    baseUrl?: string;
    azureApiVersion?: string;
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

export type AgentHarnessAttemptParams =
  import("../embedded-agent-runner/run/types.js").EmbeddedRunAttemptParams;
export type AgentHarnessAttemptResult =
  import("../embedded-agent-runner/run/types.js").EmbeddedRunAttemptResult;
export type AgentHarnessSideQuestionParams = {
  cfg: import("../../config/types.openclaw.js").OpenClawConfig;
  agentDir: string;
  provider: string;
  model: string;
  runtimeModel?: import("openclaw/plugin-sdk/llm").Model<import("openclaw/plugin-sdk/llm").Api>;
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
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
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

export type AgentHarnessResultClassification =
  | "ok"
  | NonNullable<AgentHarnessAttemptResult["agentHarnessResultClassification"]>;

export type AgentHarnessDeliveryDefaults = {
  /**
   * @deprecated Prefer `messages.visibleReplies` / `messages.groupChat.visibleReplies`
   * config. Kept for existing harness plugins.
   */
  sourceVisibleReplies?: "automatic" | "message_tool";
};

type AgentHarnessRunCapability = {
  id: string;
  label: string;
  pluginId?: string;
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

export type AgentHarness = AgentHarnessRunCapability &
  AgentHarnessSideQuestionCapability &
  AgentHarnessClassificationCapability &
  AgentHarnessCompactionCapability &
  AgentHarnessSessionLifecycleCapability;

export type RegisteredAgentHarness = {
  harness: AgentHarness;
  ownerPluginId?: string;
};
