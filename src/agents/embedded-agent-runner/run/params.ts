/**
 * Shared parameter types for embedded-agent run orchestration.
 */
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type {
  BlockReplyContext,
  PartialReplyPayload,
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../../auto-reply/reply-payload.js";
import type { ReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import type { ChatType } from "../../../channels/chat-type.js";
import type { InboundEventKind } from "../../../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ImageContent } from "../../../llm/types.js";
import type { MediaFact } from "../../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import type { PluginHookChannelContext } from "../../../plugins/hook-types.js";
import type { RuntimePluginToolGrant } from "../../../plugins/runtime/tool-grant.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import type { SkillSnapshot } from "../../../skills/types.js";
import type {
  SkillProposalOrigin,
  SkillWorkshopProposalMutationBudget,
  SkillWorkshopRunOptions,
} from "../../../skills/workshop/types.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "../../bash-tools.exec-types.js";
import type { BootstrapContextRunKind } from "../../bootstrap-mode.js";
import type { AgentStreamParams, ClientToolDefinition } from "../../command/shared-types.js";
import type { ConversationRecallContext } from "../../conversation-recall.types.js";
import type { BlockReplyPayload } from "../../embedded-agent-payloads.js";
import type {
  BlockReplyChunking,
  ToolProgressDetailMode,
  ToolResultFormat,
} from "../../embedded-agent-subscribe.shared-types.js";
import type { FastModeAutoProgressState } from "../../fast-mode.js";
import type { ExpectedAgentHarnessRuntimeArtifact } from "../../harness/runtime-artifact.types.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import type { AgentRunSessionTarget } from "../../run-session-target.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { ScheduledToolPolicyContext } from "../../scheduled-tool-policy.js";
import type { SessionManager } from "../../sessions/index.js";
import type { SilentReplyPromptMode } from "../../system-prompt.types.js";
import type { PromptMode } from "../../system-prompt.types.js";
import type { EmbeddedAgentExecutionPhase } from "../execution-phase.js";
import type { BlockReplyFlushContext } from "../types.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";
export type { ClientToolDefinition } from "../../command/shared-types.js";

export type EmbeddedRunTrigger = "cron" | "heartbeat" | "manual" | "memory" | "overflow" | "user";

type ReasoningStreamPayload = Pick<
  ReplyPayload,
  "text" | "mediaUrls" | "isReasoning" | "isReasoningSnapshot"
> & {
  requiresReasoningProgressOptIn?: boolean;
};

export type CurrentInboundPromptContext = {
  text: string;
  resumableText?: string;
  promptJoiner?: "\n\n" | "\n" | " ";
  /** Generated goal blocks owned by inbound-context assembly, never user text. */
  injectedGoalContexts?: string[];
};

export type RunEmbeddedAgentParams = {
  /** Caller-owned in-memory transcript for ephemeral helper runs. */
  sessionManager?: SessionManager;
  sessionId: string;
  sessionKey?: string;
  /** Storage-neutral transcript/session target. Defaults to sessionId/sessionKey/agentId. */
  sessionTarget?: AgentRunSessionTarget;
  /** Immutable gateway lifecycle ownership captured when this execution was admitted. */
  lifecycleGeneration?: string;
  /** Provider prompt-cache affinity key; distinct from transcript/session identity. */
  promptCacheKey?: string;
  /** Session-like key for sandbox and tool-policy resolution. Defaults to sessionKey. */
  sandboxSessionKey?: string;
  agentId?: string;
  messageChannel?: string;
  messageProvider?: string;
  /** Capabilities declared by the gateway client that originated this run. */
  clientCaps?: string[];
  /** Out-of-band plugin bindings attached by the run initiator. */
  toolBindings?: Readonly<Record<string, unknown>>;
  chatType?: ChatType;
  agentAccountId?: string;
  /** What initiated this agent run: "user", "heartbeat", "cron", "memory", "overflow", or "manual". */
  trigger?: EmbeddedRunTrigger;
  /** Stable cron job identifier populated for cron-triggered runs. */
  jobId?: string;
  /** Relative workspace path that memory-triggered writes are allowed to append to. */
  memoryFlushWritePath?: string;
  /** Delivery target for topic/thread routing. */
  messageTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  messageThreadId?: string | number;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Trusted provider role ids for the requester in this group turn. */
  memberRoleIds?: string[];
  /** Opaque host-issued capability for current-turn channel message actions. */
  messageActionTurnCapability?: string;
  /** Parent session key for subagent policy inheritance. */
  spawnedBy?: string | null;
  /** Whether workspaceDir points at the canonical agent workspace for bootstrap purposes. */
  isCanonicalWorkspace?: boolean;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  /** Trusted sender identity bit for command/channel-action auth. */
  senderIsOwner?: boolean;
  /** Device-scoped operator session allowed to review approvals initiated by this run. */
  approvalReviewerDeviceId?: string;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Transport-native chat/conversation ID for hook identity context. */
  chatId?: string;
  /** Channel-specific identity metadata surfaced to plugin hooks. */
  channelContext?: PluginHookChannelContext;
  /** Routable target for the current conversation when it differs from the native channel ID. */
  currentMessagingTarget?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Current inbound message id for action fallbacks (e.g. Telegram react). */
  currentMessageId?: string | number;
  /** True when the current inbound turn carried audio media. */
  currentInboundAudio?: boolean;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** Require explicit message tool targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean;
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
  swarmCollector?: boolean;
  swarmOutputSchema?: Record<string, unknown>;
  /** Restrict this reconstructed run to restart-safe tools. */
  forceRestartSafeTools?: boolean;
  /** Internal one-shot model probe mode: no tools, no workspace/chat prompt policy. */
  modelRun?: boolean;
  /** Disable trajectory persistence for auxiliary runs with no durable session owner. */
  disableTrajectory?: boolean;
  /** Restrict Skill Workshop to a bounded pending-proposal budget for an internal review run. */
  skillWorkshopProposalOnly?: boolean;
  /** Preserve the foreground run as proposal provenance for an internal review run. */
  skillWorkshopOrigin?: SkillProposalOrigin;
  /** Run-scoped mutation budget shared across internal runner attempts. */
  skillWorkshopProposalMutationBudget?: SkillWorkshopProposalMutationBudget;
  /** Optional state environment for isolated Skill Workshop proposal persistence. */
  skillWorkshopProposalEnv?: NodeJS.ProcessEnv;
  /** Shared completion latch for proposal-only review runs that checkpoint their batch. */
  skillWorkshopProposalReviewCompletion?: SkillWorkshopRunOptions["proposalReviewCompletion"];
  /** Explicit system prompt mode override for trusted callers. */
  promptMode?: PromptMode;
  /** Keep the message tool available even when a narrow profile would omit it. */
  forceMessageTool?: boolean;
  /** Include the heartbeat response tool for structured heartbeat outcomes. */
  enableHeartbeatTool?: boolean;
  /** Keep the heartbeat response tool available even when a narrow profile would omit it. */
  forceHeartbeatTool?: boolean;
  /** Allow runtime plugins for this run to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
  /** @deprecated Use sessionTarget plus sessionId/sessionKey/agentId for runtime identity. */
  sessionFile?: string;
  workspaceDir: string;
  /** Task working directory for tool/runtime execution. Defaults to workspaceDir. */
  cwd?: string;
  agentDir?: string;
  /**
   * Run config consumed by core paths (model selection, tools, plugin
   * activation). Plugin harnesses resolve `plugins.entries.<id>.config` from
   * the live global config, NOT from this object — per-run plugin-config
   * overrides are unsupported; use an explicit run param instead.
   */
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  prompt: string;
  /** User-visible prompt body to submit and persist; runtime context travels separately. */
  transcriptPrompt?: string;
  currentInboundEventKind?: InboundEventKind;
  currentInboundContext?: CurrentInboundPromptContext;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  /** Ordered facts represented by attachment text in the current prompt. */
  media?: MediaFact[];
  /** Optional client-provided tools (OpenResponses hosted tools). */
  clientTools?: ClientToolDefinition[];
  /** Disable built-in tools for this run (LLM-only mode). */
  disableTools?: boolean;
  provider?: string;
  model?: string;
  /** Effective model fallback chain for this session attempt. Undefined uses config defaults. */
  modelFallbacksOverride?: string[];
  /** Session-pinned embedded harness id. Prevents runtime hot-switching. */
  agentHarnessId?: string;
  /** True when the pinned non-default harness owns model selection for this session. */
  modelSelectionLocked?: boolean;
  /** Explicit runtime override selected for this turn. Unlike agentHarnessId, this may force OpenClaw. */
  agentHarnessRuntimeOverride?: string;
  /** Verified setup continuation: pin both the harness and its local implementation. */
  expectedAgentHarnessRuntimeArtifact?: ExpectedAgentHarnessRuntimeArtifact;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  thinkLevel?: ThinkLevel;
  fastMode?: FastMode;
  /** Stable outer-run start time for auto fast-mode cutoff across retries/fallbacks. */
  fastModeStartedAtMs?: number;
  /** Effective auto fast-mode cutoff for this run, in seconds. */
  fastModeAutoOnSeconds?: number;
  /** Shared notification state for nested harnesses that can observe the same tool boundary. */
  fastModeAutoProgressState?: FastModeAutoProgressState;
  /** True when the outer model fallback loop has reached its final candidate. */
  isFinalFallbackAttempt?: boolean;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  toolProgressDetail?: ToolProgressDetailMode;
  /** If true, suppress tool error warning payloads for this run (including mutating tools). */
  suppressToolErrorWarnings?: boolean | (() => boolean | undefined);
  /** Bootstrap context mode for workspace file injection. */
  bootstrapContextMode?: "full" | "lightweight";
  /** Run kind hint for context mode behavior. */
  bootstrapContextRunKind?: BootstrapContextRunKind;
  /** Optional tool allow-list; when set, only these tools are sent to the model. */
  toolsAllow?: string[];
  /** Owner-scoped plugin tool grant; normal policy and deny rules still apply. */
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  /** Trusted in-process subagent-completion handoff; never derived from public input. */
  trustedInternalHandoff?: boolean;
  /** Trusted server-stamped authority for an explicitly capped scheduled run. */
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  /** Seen bootstrap truncation warning signatures for this session (once mode dedupe). */
  bootstrapPromptWarningSignaturesSeen?: string[];
  /** Last shown bootstrap truncation warning signature for this session. */
  bootstrapPromptWarningSignature?: string;
  execOverrides?: Pick<
    ExecToolDefaults,
    "host" | "security" | "ask" | "node" | "nodeCwd" | "notifyOnExit" | "notifyOnExitEmptySuccess"
  >;
  bashElevated?: ExecElevatedDefaults;
  timeoutMs: number;
  /**
   * Explicit per-run timeout override, in milliseconds, when the caller knows
   * the run was launched with a deliberate per-run value (e.g. a cron payload's
   * `timeoutSeconds`) rather than inheriting `agents.defaults.timeoutSeconds`.
   * When set, the LLM idle watchdog honors this value directly instead of
   * inferring "explicitness" from `timeoutMs !== agents.defaults.timeoutSeconds`,
   * which fails when the explicit value happens to numerically equal the agent
   * default.
   */
  runTimeoutOverrideMs?: number;
  runId: string;
  /** Trusted runtime-only authorization for one bounded cross-conversation recall pass. */
  conversationRecall?: ConversationRecallContext;
  abortSignal?: AbortSignal;
  onExecutionStarted?: (info?: { lifecycleGeneration?: string }) => void;
  onExecutionPhase?: (info: {
    phase: EmbeddedAgentExecutionPhase;
    provider?: string;
    model?: string;
    backend?: string;
    source?: string;
    tool?: string;
    toolCallId?: string;
    itemId?: string;
    firstModelCallStarted?: boolean;
  }) => void;
  onLaneWait?: (info: { waitMs: number; queuedAhead: number; waiting?: boolean }) => void;
  onRunProgress?: (info: {
    reason: string;
    provider?: string;
    model?: string;
    backend?: string;
  }) => void;
  onSessionIdChanged?: (sessionId: string) => void;
  replyOperation?: ReplyOperation;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  onPartialReply?: (payload: PartialReplyPayload) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onBlockReply?: (payload: BlockReplyPayload, context?: BlockReplyContext) => void | Promise<void>;
  onBlockReplyFlush?: (context: BlockReplyFlushContext) => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onReasoningStream?: (payload: ReasoningStreamPayload) => void | Promise<void>;
  streamReasoningInNonStreamModes?: boolean;
  onReasoningEnd?: () => void | Promise<void>;
  onToolResult?: (payload: ReplyPayload) => void | Promise<void>;
  /** Synchronous private observer for the sanitized per-tool result. */
  onAgentToolResult?: (event: { toolName: string; result: unknown; isError: boolean }) => void;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
    sessionKey?: string;
  }) => void | Promise<void>;
  onToolStreamBoundary?: () => void | Promise<void>;
  /**
   * Emit lifecycle "finishing" when the attempt ends; the caller owns the
   * final lifecycle "end" or "error" after fallback and post-turn work settle.
   */
  deferTerminalLifecycle?: boolean;
  /** @deprecated Use deferTerminalLifecycle. */
  deferTerminalLifecycleEnd?: boolean;
  lane?: string;
  enqueue?: CommandQueueEnqueueFn;
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  silentReplyPromptMode?: SilentReplyPromptMode;
  internalEvents?: AgentInternalEvent[];
  inputProvenance?: InputProvenance;
  streamParams?: AgentStreamParams;
  ownerNumbers?: string[];
  enforceFinalTag?: boolean;
  silentExpected?: boolean;
  /** Skip per-chunk live visible-text parsing when no live stream consumer exists (e.g. subagents). */
  suppressLiveStreamOutput?: boolean;
  /**
   * Treat a clean empty assistant stop as an intentional silent reply.
   * Only set when the caller's prompt policy already allows an exact NO_REPLY
   * final answer for silence.
   */
  allowEmptyAssistantReplyAsSilent?: boolean;
  /**
   * Whether this run still owes a visible reply after settled non-reporting tools.
   * Exact configured silence and committed delivery remain terminal outcomes.
   */
  terminalReplyExpectation?: "required" | "optional";
  authProfileFailurePolicy?: AuthProfileFailurePolicy;
  /**
   * One-shot helper runs may opt in to executing through the provider's CLI
   * backend instead of the direct-API passthrough when the run targets a CLI
   * runtime provider whose passthrough credentials are subscription-scoped.
   * Anthropic routes direct anthropic-messages calls on subscription OAuth to
   * metered extra-usage billing: without extra-usage balance the passthrough
   * fails closed with a billing error, and with it the run silently draws
   * paid usage instead of plan limits. The CLI backend is the plan-limits
   * path for those credentials. CLI dispatch translates `toolsAllow` into the
   * selectable-backend surface (no native tools, allowlisted loopback MCP
   * tools); the same list bounds the loopback MCP grant server-side, so tools
   * outside it — including the message tool, matching `disableMessageTool`
   * intent — can be neither listed nor called. Leave unset to keep the
   * direct-API passthrough.
   */
  cliBackendDispatch?: "subscription-auth";
  /**
   * Allow a single run attempt even when all auth profiles are in cooldown,
   * but only for inferred transient cooldowns like `rate_limit` or `overloaded`.
   *
   * This is used by model fallback when trying sibling models on providers
   * where transient service pressure is often model-scoped.
   */
  allowTransientCooldownProbe?: boolean;
  suppressNextUserMessagePersistence?: boolean;
  suppressTranscriptOnlyAssistantPersistence?: boolean;
  suppressAssistantErrorPersistence?: boolean;
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  /** Keep an internal continuation prompt from being replaced by the original prepared turn. */
  skipPreparedUserTurnMessage?: boolean;
  onUserMessagePersisted?: (message: Extract<AgentMessage, { role: "user" }>) => void;
  onUserMessagePersistenceInvalidated?: () => void;
  onAssistantErrorMessagePersisted?: (
    message: Extract<AgentMessage, { role: "assistant" }>,
  ) => void;
  /**
   * Dispose bundled MCP runtimes when the overall run ends instead of preserving
   * the session-scoped cache. Intended for one-shot local CLI runs that must
   * exit promptly after emitting the final JSON result.
   */
  cleanupBundleMcpOnRunEnd?: boolean;
  /** Mark explicit one-shot local CLI runs so plugin tools can release resources promptly. */
  oneShotCliRun?: boolean;
};
