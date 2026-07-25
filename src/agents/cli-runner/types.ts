import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
/**
 * Shared types for preparing and executing CLI-backed agent runs.
 */
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../../auto-reply/get-reply-options.types.js";
import type { ReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { FastMode } from "../../auto-reply/thinking.shared.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { CliSessionBinding, SessionEntry } from "../../config/sessions.js";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { ImageContent } from "../../llm/types.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import type { CliBackendExecutionMode } from "../../plugins/cli-backend.types.js";
import type { PluginHookChannelContext } from "../../plugins/hook-types.js";
import type { SpawnSecretInput } from "../../process/supervisor/types.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { ExecElevatedDefaults } from "../bash-tools.exec-types.js";
import type { BootstrapContextMode } from "../bootstrap-files.js";
import type { BootstrapContextRunKind } from "../bootstrap-mode.js";
import type { ResolvedCliBackend } from "../cli-backends.js";
import type { CliSessionReuseResult } from "../cli-session.js";
import type { ContextWindowInfo } from "../context-window-guard.js";
import type { FailoverReason } from "../embedded-agent-helpers.js";
import type { EmbeddedAgentExecutionPhase } from "../embedded-agent-runner/execution-phase.js";
import type {
  CurrentInboundPromptContext,
  EmbeddedRunTrigger,
} from "../embedded-agent-runner/run/params.js";
import type { ExecPolicyOverrides } from "../exec-defaults.js";
import type { FastModeAutoProgressState } from "../fast-mode.js";
import type { ScheduledToolPolicyContext } from "../scheduled-tool-policy.js";
import type { SilentReplyPromptMode } from "../system-prompt.types.js";

/** Input contract for one CLI-backed agent run. */
export type RunCliAgentParams = {
  sessionId: string;
  sessionKey?: string;
  /** Session identity used only for sandbox and tool-policy resolution. */
  runtimePolicySessionKey?: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  trigger?: EmbeddedRunTrigger;
  sessionFile: string;
  workspaceDir: string;
  /** Trusted model/auth owner directory. Defaults to the session agent directory. */
  agentDir?: string;
  /** Task working directory for CLI execution. Defaults to workspaceDir. */
  cwd?: string;
  /** Start a fresh CLI process so per-turn MCP authority is reloaded from this run. */
  disableCliLiveSession?: boolean;
  config?: OpenClawConfig;
  prompt: string;
  transcriptPrompt?: string;
  /** Undecorated current-turn prompt used to merge inline and offloaded images. */
  imagePrompt?: string;
  /**
   * Execution mode for the generic CLI runner. Side questions are one-shot
   * background answers and must not reuse or mutate normal agent sessions.
   */
  executionMode?: CliBackendExecutionMode;
  /** Persist the successful CLI assistant reply into the OpenClaw session transcript. */
  persistAssistantTranscript?: boolean;
  /** Session store path used when assistant transcript persistence is enabled. */
  storePath?: string;
  /** Canonical user-turn recorder shared with gateway/queue dispatch. */
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  /** Skip current-turn user persistence when a retry/fallback already wrote it. */
  suppressNextUserMessagePersistence?: boolean;
  /** Notification fired after the current user turn has been accepted into the transcript. */
  onUserMessagePersisted?: (message: Extract<AgentMessage, { role: "user" }>) => void;
  currentInboundEventKind?: InboundEventKind;
  currentInboundContext?: CurrentInboundPromptContext;
  inputProvenance?: InputProvenance;
  /** Selected model provider used for tool policy; distinct from a CLI runtime id. */
  modelProvider?: string;
  provider: string;
  model?: string;
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
  timeoutMs: number;
  /**
   * Explicit run timeout, in milliseconds, when the caller can distinguish a
   * deliberate timeout override from the inherited agent default.
   */
  runTimeoutOverrideMs?: number;
  runId: string;
  /** Immutable lifecycle ownership captured when this execution was admitted. */
  lifecycleGeneration?: string;
  lane?: string;
  jobId?: string;
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  requireExplicitMessageTarget?: boolean;
  silentReplyPromptMode?: SilentReplyPromptMode;
  allowEmptyAssistantReplyAsSilent?: boolean;
  /** Static portion of extraSystemPrompt (excluding per-message inbound metadata) for session reuse hashing. */
  extraSystemPromptStatic?: string;
  cliSessionBindingFacts?: CliSessionBindingFacts;
  streamParams?: import("../command/shared-types.js").AgentStreamParams;
  ownerNumbers?: string[];
  cliSessionId?: string;
  cliSessionBinding?: CliSessionBinding;
  /** Consume the backend fork argument on this resume invocation only. */
  forkCliSessionOnResume?: boolean;
  /** Atomically claim the persisted one-shot marker after the CLI queue admits this turn. */
  claimCliSessionFork?: () => Promise<boolean>;
  /** Re-arm a claimed marker when the CLI turn fails before producing a successor session. */
  restoreCliSessionFork?: () => Promise<void>;
  /** Persist the successor ID as soon as the CLI reports the forked session. */
  persistCliSessionForkSuccessor?: (sessionId: string) => Promise<void>;
  authProfileId?: string;
  /** Private seam: report the credential/runtime owner only after a successful real turn. */
  onSuccessfulAuthBinding?: (binding: {
    authProfileId?: string;
    authFingerprint?: string;
    runtimeOwnerFingerprint?: string;
    runtimeOwnerKind?: "cli-runtime" | "plugin-harness" | "aws-sdk";
    runtimeOwnerId?: string;
    runtimeArtifactFingerprint?: string;
    runtimeArtifactId?: string;
    skipLocalCredential?: true;
  }) => void;
  onBeforeFreshCliSessionRetry?: (params: {
    provider: string;
    reason: FailoverReason;
    sessionId: string;
  }) => boolean | Promise<boolean>;
  bootstrapPromptWarningSignaturesSeen?: string[];
  bootstrapPromptWarningSignature?: string;
  bootstrapContextMode?: BootstrapContextMode;
  bootstrapContextRunKind?: BootstrapContextRunKind;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  /** Ordered facts represented by attachment text in the current prompt. */
  media?: MediaFact[];
  skillsSnapshot?: SkillSnapshot;
  messageChannel?: string;
  messageProvider?: string;
  /** Capabilities declared by the gateway client that originated this run. */
  clientCaps?: string[];
  currentChannelId?: string;
  chatId?: string;
  channelContext?: PluginHookChannelContext;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentInboundAudio?: boolean;
  agentAccountId?: string;
  /** Sender identity for channel-originated runs when available. */
  senderId?: string | null;
  /** Trusted sender identity bit for channel action auth. */
  senderIsOwner?: boolean;
  /** Additional trusted sender identities used by toolsBySender policy. */
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  /** Group policy context captured from the originating run. */
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  /** Parent session provenance used to validate inherited group policy. */
  spawnedBy?: string | null;
  /** Effective turn-local exec policy resolved before entering the CLI runtime. */
  execOverrides?: ExecPolicyOverrides;
  /** Effective elevated-exec defaults resolved before entering the CLI runtime. */
  bashElevated?: ExecElevatedDefaults;
  /** Device-scoped operator session allowed to review approvals initiated by this run. */
  approvalReviewerDeviceId?: string;
  /** Runtime tool allow-list. CLI harnesses need a backend-owned exact translation. */
  toolsAllow?: string[];
  /** Trusted server-stamped authority for an explicitly capped scheduled run. */
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  /** Exact native plus canonical OpenClaw surface for a selectable CLI backend. */
  cliToolAvailability?: {
    native: string[];
    openClaw: string[];
  };
  disableTools?: boolean;
  abortSignal?: AbortSignal;
  onExecutionStarted?: () => void;
  onExecutionPhase?: (info: {
    phase: EmbeddedAgentExecutionPhase;
    provider?: string;
    model?: string;
    backend?: string;
    source?: string;
    firstModelCallStarted?: boolean;
  }) => void;
  replyOperation?: ReplyOperation;
  emitCommentaryText?: boolean;
  /**
   * Close any long-lived CLI live session created for this run after the run
   * finishes. Intended for temporary helper calls that should not keep process
   * handles alive after returning.
   */
  cleanupCliLiveSessionOnRunEnd?: boolean;
  /**
   * Close process-wide bundle MCP resources after this run. Intended for
   * one-shot local CLI calls where the loopback server should not keep Node
   * alive after the JSON response is emitted.
   */
  cleanupBundleMcpOnRunEnd?: boolean;
  /** Mark explicit one-shot local CLI runs so plugin tools can release resources promptly. */
  oneShotCliRun?: boolean;
};

/** Backend config after MCP, skill, env, and cleanup preparation. */
export type CliSecretInput = SpawnSecretInput & {
  /** Process-local non-secret generation used only to invalidate a warm child. */
  fingerprint: string;
};

type CliPreparedBackend = {
  backend: CliBackendConfig;
  beforeExecution?: () => Promise<void>;
  cleanup?: () => Promise<void>;
  /** Private child-only credential transport; never serialized into env or public plugin state. */
  secretInput?: CliSecretInput;
  /** Gateway-owned capture fence for this prepared bundle-MCP client. */
  mcpClientGrantCapture?: {
    activate: (captureKey: string) => void;
    deactivate: (captureKey: string) => void;
  };
  mcpConfigHash?: string;
  mcpResumeHash?: string;
  env?: Record<string, string>;
};

/** Reusable CLI session id, soft content drift, or hard invalidation. */
export type CliReusableSession =
  | CliSessionReuseResult
  | {
      mode: "invalidate";
      invalidatedReason: "system-prompt" | "missing-transcript" | "orphaned-tool-use";
    };

export type CliSessionBindingFacts = {
  extraSystemPromptStatic?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  requireExplicitMessageTarget?: boolean;
};

/** Fully prepared execution context consumed by the CLI runner executor. */
export type PreparedCliRunContext = {
  params: RunCliAgentParams;
  effectiveAuthProfileId?: string;
  agentDir?: string;
  started: number;
  workspaceDir: string;
  cwd?: string;
  backendResolved: ResolvedCliBackend;
  preparedBackend: CliPreparedBackend;
  reusableCliSession: CliReusableSession;
  /** Resume is safe only while the exact managed Claude stdio child still exists. */
  requiredClaudeLiveSessionGeneration?: string;
  hadSessionFile: boolean;
  contextEngineConfig: OpenClawConfig;
  contextEngine?: ContextEngine;
  contextEngineTurnPrompt?: string;
  contextEngineDeferredTurnMaintenance?: Promise<void>;
  modelId: string;
  normalizedModel: string;
  contextWindowInfo?: ContextWindowInfo;
  systemPrompt: string;
  systemPromptReport: SessionSystemPromptReport;
  claudeSkillsPluginArgs?: string[] | undefined;
  bootstrapPromptWarningLines: string[];
  openClawHistoryPrompt?: string;
  heartbeatPrompt?: string;
  authEpoch?: string;
  /** Strict owner fingerprint captured for live inference verification only. */
  authBindingFingerprint?: string;
  /** Stable CLI backend/profile owner shape, usable only with a successful native session. */
  runtimeOwnerFingerprint?: string;
  /** Exact executable/package implementation used by this CLI process. */
  runtimeArtifactFingerprint?: string;
  authBindingSkipsLocalCredential?: true;
  authEpochVersion: number;
  extraSystemPromptHash?: string;
  messageToolPolicyHash?: string;
  promptToolNamesHash?: string;
  cwdHash?: string;
  mcpDeliveryCapture?: true;
};
