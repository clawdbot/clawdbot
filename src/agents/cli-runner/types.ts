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
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { ImageContent } from "../../llm/types.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { CliBackendExecutionMode } from "../../plugins/cli-backend.types.js";
import type { PluginHookChannelContext } from "../../plugins/hook-types.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.types.js";
import type { SkillSnapshot } from "../../skills/types.js";
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
import type { FastModeAutoProgressState } from "../fast-mode.js";
import type { SilentReplyPromptMode } from "../system-prompt.types.js";

/** Input contract for one CLI-backed agent run. */
export type RunCliAgentParams = {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  trigger?: EmbeddedRunTrigger;
  sessionFile: string;
  workspaceDir: string;
  /** Task working directory for CLI execution. Defaults to workspaceDir. */
  cwd?: string;
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
  suppressNextUserMessagePersistence?: boolean;
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  onUserMessagePersisted?: (message: PersistedUserTurnMessage) => void | Promise<void>;
  /** Persist the successful CLI assistant reply into the OpenClaw session transcript. */
  persistAssistantTranscript?: boolean;
  /** Session store path used when assistant transcript persistence is enabled. */
  storePath?: string;
  currentInboundEventKind?: InboundEventKind;
  currentInboundContext?: CurrentInboundPromptContext;
  inputProvenance?: InputProvenance;
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
  streamParams?: import("../command/types.js").AgentStreamParams;
  ownerNumbers?: string[];
  cliSessionId?: string;
  cliSessionBinding?: CliSessionBinding;
  authProfileId?: string;
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
  /** Device-scoped operator session allowed to review approvals initiated by this run. */
  approvalReviewerDeviceId?: string;
  /** Runtime tool allow-list. CLI harnesses fail closed when this is set. */
  toolsAllow?: string[];
  /**
   * Ring-zero Crestodian tool served over a dedicated stdio MCP server; set
   * only by the Crestodian agent runner. Replaces the normal bundle MCP
   * surface for the run — the harness still owns its native tools.
   */
  crestodianTool?: import("../tools/crestodian-tool.js").CrestodianToolOptions;
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
export type CliPreparedBackend = {
  backend: CliBackendConfig;
  beforeExecution?: () => Promise<void>;
  cleanup?: () => Promise<void>;
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
  started: number;
  workspaceDir: string;
  cwd?: string;
  backendResolved: ResolvedCliBackend;
  preparedBackend: CliPreparedBackend;
  reusableCliSession: CliReusableSession;
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
  authEpochVersion: number;
  extraSystemPromptHash?: string;
  messageToolPolicyHash?: string;
  promptToolNamesHash?: string;
  cwdHash?: string;
  mcpDeliveryCapture?: true;
};
