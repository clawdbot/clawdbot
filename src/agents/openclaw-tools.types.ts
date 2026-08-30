import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import type { ChatType } from "../channels/chat-type.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { ConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecMode } from "../infra/exec-approvals.js";
import type { SkillWorkshopRunOptions } from "../skills/workshop/types.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import type { ConversationRecallContext } from "./conversation-recall.types.js";
import type { ExecPolicyOverrides, ExecSessionDefaults } from "./exec-defaults.js";
import type { ModelAwareToolContext } from "./openclaw-tools.model-context.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import type { ContinueWorkRequest } from "./tools/continue-work-tool.js";
import type { CronToolOptions } from "./tools/cron-tool.types.js";
import type { RequestCompactionToolOpts } from "./tools/request-compaction-tool.js";

export type OpenClawToolsOptions = {
  sandboxBrowserBridgeUrl?: string;
  allowHostBrowserControl?: boolean;
  agentSessionKey?: string;
  toolBindings?: Readonly<Record<string, unknown>>;
  /** Durable store key when it differs from the sandbox/policy session key. */
  runSessionKey?: string;
  agentChannel?: string;
  runId?: string;
  /** Exact admitted session policy shared with terminal-input authorization. */
  execSession?: ExecSessionDefaults;
  /** Effective run-local exec overrides, including prepared permission mode. */
  execOverrides?: ExecPolicyOverrides & { mode?: ExecMode };
  /** Trusted operator devices allowed to review this run's terminal input. */
  approvalReviewerDeviceIds?: string[];
  agentAccountId?: string;
  /** Trusted account used for authorization; delivery keeps agentAccountId. */
  gatewayCallerAccountId?: string;
  gatewayCallerChannel?: string | null;
  /** True only for explicit server-authored local scheduled provenance. */
  gatewayCallerLocal?: boolean;
  /** True only for a validated scheduled tool policy. */
  gatewayCallerScheduled?: boolean;
  /** Delivery target for topic/thread routing. */
  agentTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  agentThreadId?: string | number;
  /** Trusted platform-native conversation id for the active inbound turn. */
  nativeChannelId?: string;
  /** Opaque host-issued capability for current-turn channel message actions. */
  messageActionTurnCapability?: string;
  sandboxRoot?: string;
  sandboxContainerWorkdir?: string;
  sandboxFsBridge?: SandboxFsBridge;
  sandboxWritable?: boolean;
  /** Prepared effective read authorization for exporting sandbox workspace media. */
  sandboxWorkspaceMediaReadAllowed?: boolean;
  fsPolicy?: ToolFsPolicy;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  /** Gateway-owned session policy follows runtime updates; explicit overrides stay pinned. */
  sessionConfigSource?: "runtime" | "pinned";
  webFetchHostnameAllowlistRef?: { value?: string[] };
  webSearchEnabled?: boolean;
  /** Capabilities declared by the gateway client that originated this run. */
  clientCaps?: string[];
  pluginToolAllowlist?: string[];
  pluginToolDenylist?: string[];
  runtimeToolAllowlist?: string[];
  /** Host-prepared proof that this exact session can request Gateway publication. */
  githubPublicationAvailable?: boolean;
  /** Effective caller tool surface to persist on isolated cron agentTurn jobs. */
  cronCreatorToolAllowlist?: CronToolOptions["creatorToolAllowlist"];
  cronCreatorToolAllowlistCaptureRef?: CronToolOptions["creatorToolAllowlistCaptureRef"];
  resolveCronCreatorToolAuthority?: CronToolOptions["resolveCreatorToolAuthority"];
  cronCreatorAuthorityUnavailableReason?: CronToolOptions["creatorAuthorityUnavailableReason"];
  /** Current channel ID for auto-threading. */
  currentChannelId?: string;
  /** Trusted normalized conversation kind for the active inbound turn. */
  currentChatType?: ChatType;
  /** Routable target for the current conversation when it differs from the native channel ID. */
  currentMessagingTarget?: string;
  /** Current thread timestamp for auto-threading. */
  currentThreadTs?: string;
  /** Current inbound message id for action fallbacks. */
  currentMessageId?: string | number;
  /** True when the current inbound turn carried audio media. */
  currentInboundAudio?: boolean;
  /** Dynamic audio state for runs that can accept steered input after tool creation. */
  hasCurrentInboundAudio?: () => boolean;
  /** Reply-to mode for auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** Fail closed instead of posting same-channel thread-originated replies at the root. */
  sameChannelThreadRequired?: boolean;
  /** Mutable model-context generation used to expire screenshot coordinate frames. */
  computerContextEpoch?: { value: number };
  /** Registers run-owned cleanup for tools that hold node resources. */
  registerRunCleanup?: (cleanup: (reason: string) => Promise<void>) => void;
  /** Internal review-run restrictions and proposal provenance. */
  skillWorkshop?: SkillWorkshopRunOptions;
  /** If true, nodes action="invoke" can call media-returning commands directly. */
  allowMediaInvokeCommands?: boolean;
  /** Trusted sender identity bit for channel action auth. */
  senderIsOwner?: boolean;
  /** Server-owned operation-local origin for conversation-read visibility policy. */
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  /** Restrict cron operations to the active cron job's self-scoped surface. */
  cronSelfRemoveOnlyJobId?: string;
  /** Require explicit message targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean;
  /** Visible source replies must be sent through the message tool when set to message_tool_only. */
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  /** Process-local completion authority restricted to the current source conversation. */
  sourceReplyOnly?: boolean;
  /** Action sink available for model-proposed follow-up tasks. */
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  inboundEventKind?: InboundEventKind;
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
  swarmCollector?: boolean;
  swarmOutputSchema?: Record<string, unknown>;
  /** If true, include the heartbeat response tool for structured heartbeat outcomes. */
  enableHeartbeatTool?: boolean;
  /** If true, skip plugin tool resolution and return only shipped core tools. */
  disablePluginTools?: boolean;
  /**
   * Wrap returned tools with the before_tool_call hook at construction time.
   * Defaults to true; callers that already enforce the hook at a later shared
   * boundary should opt out explicitly.
   */
  wrapBeforeToolCallHook?: boolean;
  /** Override or extend the default hook context used by construction-time wrapping. */
  beforeToolCallHookContext?: HookContext;
  /** Records hot-path tool-prep stages for reply startup diagnostics. */
  recordToolPrepStage?: (name: string) => void;
  /** Trusted sender id from inbound context (not tool args). */
  requesterSenderId?: string | null;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  /** Trusted runtime-only authorization for one bounded cross-conversation recall pass. */
  conversationRecall?: ConversationRecallContext;
  /** One-shot local CLI runs release plugin-owned resources after their result. */
  oneShotCliRun?: boolean;
  /**
   * Workspace directory to pass to spawned subagents for inheritance.
   * Defaults to workspaceDir. Use this to pass the actual agent workspace when the
   * session itself is running in a copied-workspace sandbox (`ro` or `none`) so
   * subagents inherit the real workspace path instead of the sandbox copy.
   */
  spawnWorkspaceDir?: string;
  /** Current runtime directory used as the default project for follow-up suggestions. */
  cwd?: string;
  onYield?: (message: string, acknowledgment?: string) => Promise<void> | void;
  claimYieldCompletion?: () => boolean | Promise<boolean>;
  /** Whether this run consumes the continuation delegate staging queue. */
  drainsContinuationDelegateQueue?: boolean;
  /** Internal maintenance/model-only runs that cannot schedule continuation work. */
  disableContinuationTools?: boolean;
  /** Callback for continue_work to request a post-turn continuation. */
  continueWorkOpts?: {
    requestContinuation: (request: ContinueWorkRequest) => void;
  };
  /** Closures for request_compaction when continuation is enabled. */
  requestCompactionOpts?: {
    sessionId?: string;
    getContextUsage: () => number | null;
    triggerCompaction: RequestCompactionToolOpts["triggerCompaction"];
  };
  /** Allow plugin tools for this tool set to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
} & SpawnedToolContext &
  ModelAwareToolContext;
