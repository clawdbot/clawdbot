/**
 * Public option and metadata types for agent command execution.
 */
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import type { SpawnedRunMetadata } from "../../agents/spawned-context.js";
import type { PromptMode } from "../../agents/system-prompt.types.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.public.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { PluginHookChannelContext } from "../../plugins/hook-types.js";
import type { RuntimePluginToolGrant } from "../../plugins/runtime/tool-grant.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type {
  UserTurnInput,
  UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.types.js";
import type { ExecApprovalContinuationPromptRange } from "../bash-tools.exec-approval-output.js";
import type { ExecElevatedDefaults } from "../bash-tools.exec-types.js";
import type { BootstrapContextRunKind } from "../bootstrap-mode.js";
import type { CliSessionBindingFacts } from "../cli-runner/types.js";
import type { CronCreatorAuthorityCapability } from "../cron-creator-authority-context.js";
import type { MainSessionRecoveryOwnerLease } from "../main-session-recovery/main-session-recovery-store.js";
import type { ScheduledToolPolicyContext } from "../scheduled-tool-policy.js";
import type { TrustedSubagentCompletionHandoff } from "../subagents/announce/subagent-announce-handoff.js";
import type { AgentStreamParams, ClientToolDefinition } from "./shared-types.js";

/** Image content block for Claude API multimodal messages. */
export type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

/** ACP turn source markers accepted by trusted command callsites. */
type AcpTurnSource = "manual_spawn";

/** Channel/account/thread context carried into an agent run. */
export type AgentRunContext = {
  messageChannel?: string;
  accountId?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  currentChannelId?: string;
  /** Trusted routable delivery target for send-ledger keying; distinct from the native channel id. */
  currentMessagingTarget?: string;
  /** Transport-native chat/conversation ID for plugin hook identity context. */
  chatId?: string;
  /** Channel-specific sender/chat metadata for plugin hook identity context. */
  channelContext?: PluginHookChannelContext;
  currentThreadTs?: string;
  currentInboundAudio?: boolean;
  senderId?: string | null;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
};

/** Full trusted option surface for running an agent command. */
export type AgentCommandOpts = {
  message: string;
  /** User-visible transcript body; defaults to message and excludes runtime-only context. */
  transcriptMessage?: string;
  /** Durable media metadata for the user-visible transcript turn. */
  transcriptMedia?: UserTurnInput["media"];
  /** Optional image attachments for multimodal messages. */
  images?: ImageContent[];
  /** Original inline/offloaded attachment order for inbound images. */
  imageOrder?: PromptImageOrderEntry[];
  /** Ordered facts represented by attachment text in this prompt. */
  media?: MediaFact[];
  /** Optional client-provided tools (OpenResponses hosted tools). */
  clientTools?: ClientToolDefinition[];
  /** Agent id override (must exist in config). */
  agentId?: string;
  /** Per-run provider override. */
  provider?: string;
  /** Per-run model override. */
  model?: string;
  /** Explicit ordered fallback chain for this run. Undefined uses normal selection policy. */
  modelFallbacksOverride?: string[];
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  thinking?: string;
  thinkingOnce?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  /** Override delivery target (separate from session routing). */
  replyTo?: string;
  /** Override delivery channel (separate from session routing). */
  replyChannel?: string;
  /** Override delivery account id (separate from session routing). */
  replyAccountId?: string;
  /** Override delivery thread/topic id (separate from session routing). */
  threadId?: string | number;
  /** Message channel context. */
  messageChannel?: string;
  /** Tool-policy/output surface context. Defaults to messageChannel. */
  messageProvider?: string;
  /** Delivery channel. */
  channel?: string;
  /** Account ID for multi-account channel routing. */
  accountId?: string;
  /** Context for embedded run routing (channel/account/thread). */
  runContext?: AgentRunContext;
  /** Device-scoped operator session allowed to review approvals initiated by this run. */
  approvalReviewerDeviceId?: string;
  /** Internal trusted exec approval follow-up elevated defaults. */
  bashElevated?: ExecElevatedDefaults;
  /** Trusted span whose final cap is resolved with the selected model. */
  execApprovalContinuationPromptRange?: ExecApprovalContinuationPromptRange;
  /** Corresponding span in the undecorated transcript message. */
  execApprovalContinuationTranscriptPromptRange?: ExecApprovalContinuationPromptRange;
  /** Trusted sender identity bit for command/channel-action auth; defaults true for local CLI calls. */
  senderIsOwner?: boolean;
  /** Whether this caller is authorized to use provider/model per-run overrides. */
  allowModelOverride?: boolean;
  /** Optional runtime tool allow-list; when set, only these tools are exposed for this run. */
  toolsAllow?: string[];
  /** Trusted owner-scoped plugin tool grant; normal policy and deny rules still apply. */
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  /** Consumed in-process subagent-completion capability; never accepted from public RPC params. */
  trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
  /** Internal marker identifying a server-managed default cap. */
  toolsAllowIsDefault?: boolean;
  /** Trusted server-stamped authority for an explicitly capped scheduled run. */
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  /** Preserve the originating run's message-tool policy across internal continuation turns. */
  requireExplicitMessageTarget?: boolean;
  cliSessionBindingFacts?: CliSessionBindingFacts;
  /** Group/spawn metadata for subagent policy inheritance and routing context. */
  groupId?: SpawnedRunMetadata["groupId"];
  groupChannel?: SpawnedRunMetadata["groupChannel"];
  groupSpace?: SpawnedRunMetadata["groupSpace"];
  spawnedBy?: SpawnedRunMetadata["spawnedBy"];
  deliveryTargetMode?: ChannelOutboundTargetMode;
  bestEffortDeliver?: boolean;
  abortSignal?: AbortSignal;
  lane?: string;
  runId?: string;
  /** Immutable gateway lifecycle ownership captured when this run was admitted. */
  lifecycleGeneration?: string;
  /** Called once when the selected runtime actually admits the prompt for execution. */
  onExecutionStarted?: () => void;
  extraSystemPrompt?: string;
  /** Frozen profile-backed human Git attribution prepared by trusted ingress. */
  gitCoauthorAttribution?: string;
  /** Bootstrap workspace context injection mode for this run. */
  bootstrapContextMode?: "full" | "lightweight";
  /** Run kind hint for bootstrap context behavior. */
  bootstrapContextRunKind?: BootstrapContextRunKind;
  internalEvents?: AgentInternalEvent[];
  inputProvenance?: InputProvenance;
  /** Internal runs can execute against a session without updating visible status/model/usage. */
  sessionEffects?: "visible" | "internal";
  /** Internal handoffs can write transcript turns without changing user-facing model/usage state. */
  preserveUserFacingSessionModelState?: boolean;
  /** Visible source replies must be sent through the message tool when set. */
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  /** Internal runs can omit the channel message tool entirely. */
  disableMessageTool?: boolean;
  /** Collector children fail closed instead of emitting operator approval requests. */
  swarmCollector?: boolean;
  /** Synthetic structured_output input schema for collector children. */
  swarmOutputSchema?: Record<string, unknown>;
  /** Restrict this reconstructed run to restart-safe tools. */
  forceRestartSafeTools?: boolean;
  forceCodeModeTools?: boolean;
  /** Invocation-owned Code Mode activation; limits still come from config. */
  codeModeOverride?: boolean | "auto";
  /** Host-owned exact media set for a scoped automatic recovery delivery. */
  internalDeliveryMediaUrls?: string[];
  internalDeliverySuppressText?: boolean;
  /** Gateway ingress that already persisted visible activity can skip the duplicate pre-run touch. */
  skipInitialSessionTouch?: boolean;
  /** Per-call stream param overrides (best-effort). */
  streamParams?: AgentStreamParams;
  /** Resolved per-run fast mode from channel/directive handling. */
  fastMode?: FastMode;
  /** Resolved per-run auto cutoff seconds for fast mode. */
  fastModeAutoOnSeconds?: number;
  /** Explicit workspace directory override (for subagents to inherit parent workspace). */
  workspaceDir?: SpawnedRunMetadata["workspaceDir"];
  /** Explicit task working directory for this run. Bootstrap still uses workspaceDir. */
  cwd?: string;
  /** Force bundled MCP teardown when a one-shot local run completes. */
  cleanupBundleMcpOnRunEnd?: boolean;
  /** Force long-lived CLI live session teardown when a one-shot local run completes. */
  cleanupCliLiveSessionOnRunEnd?: boolean;
  /** Mark explicit one-shot local CLI runs so plugin tools can release resources promptly. */
  oneShotCliRun?: boolean;
  /** Gateway-owned runs can late-bind plugin subagent and node runtime helpers. */
  allowGatewaySubagentBinding?: boolean;
  /** Opaque foreground fence transferred by Gateway after atomic session admission. */
  mainRestartRecoveryOwnerLease?: MainSessionRecoveryOwnerLease;
  /** Gateway already consumed this automatic recovery run's durable reservation. */
  mainRestartRecoveryAdmitted?: boolean;
  /** Exact durable recovery attempt allowed to bind post-admission execution identity. */
  mainRestartRecoveryAttempt?: number;
  /** Private recovery correlation; public ingress callers cannot author identity evidence. */
  executionIdentityAdmission?: ReturnType<
    (typeof import("../admitted-run-context.js"))["createExecutionIdentityRecoveryAdmission"]
  >;
  /** Gateway-owned exact operational instance shared with its abort controller. */
  operationalRunInstance?: import("../admitted-run-context.js").OperationalRunInstanceRef;
  skillLibraryAuthoring?: import("../../skills/library/authoring.js").SkillLibraryAuthoringCapability;
  /** Gateway-minted exact-run capability for late Codex creator-authority capture. */
  cronCreatorAuthorityCapability?: CronCreatorAuthorityCapability;
  /** Private exact-instance binding hook invoked after delegated authority admission. */
  onAdmittedRunContext?: (
    context: import("../admitted-run-context.js").AdmittedRunContext,
  ) => void | Promise<void>;
  /** Private owner binding hook invoked only after exact admission has resolved. */
  onPostAdmittedRunContext?: (
    context: import("../admitted-run-context.js").AdmittedRunContext,
  ) => void;
  /** Called when the actual run model is selected, including fallback retries. */
  onActiveModelSelected?: (ctx: { provider: string; model: string }) => void | Promise<void>;
  /** Called when every candidate in the run's model fallback chain failed. */
  onModelFallbackExhausted?: () => void;
  /** Called before delivery projection when the raw run contains an error payload. */
  onResultErrorPayload?: (message?: string) => void;
  /** Called when compaction rotates the active run onto a successor session. */
  onSessionIdChanged?: (sessionId: string) => void;
  /** Internal one-shot model probe mode: no tools, no workspace/chat prompt policy. */
  modelRun?: boolean;
  /** Internal prompt-mode override for trusted local/gateway callsites. */
  promptMode?: PromptMode;
  /** Internal ACP-ready session turn source. Manual spawn turns bypass only the dispatch gate. */
  acpTurnSource?: AcpTurnSource;
  /** Internal handoffs can feed the model without writing the synthetic prompt to transcript. */
  suppressPromptPersistence?: boolean;
  /** Gateway/channel ingress can provide a canonical user-turn persistence owner. */
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
};

/** Restricted option surface for external ingress callsites. */
export type AgentCommandIngressOpts = Omit<
  AgentCommandOpts,
  | "senderIsOwner"
  | "allowModelOverride"
  | "mainRestartRecoveryOwnerLease"
  | "mainRestartRecoveryAdmitted"
  | "mainRestartRecoveryAttempt"
  | "executionIdentityAdmission"
  | "operationalRunInstance"
  | "skillLibraryAuthoring"
  | "cronCreatorAuthorityCapability"
  | "onAdmittedRunContext"
  | "onPostAdmittedRunContext"
> & {
  /** @deprecated Public ingress ignores owner claims; use the host-injected channel runtime. */
  senderIsOwner?: boolean;
  /** Ingress callsites must always pass explicit model-override authorization state. */
  allowModelOverride: boolean;
};

/** Gateway-only ingress extends the public Plugin SDK surface with private recovery correlation. */
export type AgentCommandGatewayIngressOpts = AgentCommandIngressOpts &
  Pick<
    AgentCommandOpts,
    | "mainRestartRecoveryOwnerLease"
    | "mainRestartRecoveryAdmitted"
    | "mainRestartRecoveryAttempt"
    | "executionIdentityAdmission"
    | "operationalRunInstance"
    | "skillLibraryAuthoring"
    | "cronCreatorAuthorityCapability"
    | "onAdmittedRunContext"
    | "onPostAdmittedRunContext"
  >;
