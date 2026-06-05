/**
 * Shared types for preparing and executing CLI-backed agent runs.
 */
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { CliSessionBinding, SessionEntry } from "../../config/sessions.js";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { ImageContent } from "../../llm/types.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { BootstrapContextMode } from "../bootstrap-files.js";
import type { ResolvedCliBackend } from "../cli-backends.js";
import type { ContextWindowInfo } from "../context-window-guard.js";
import type { FailoverReason } from "../embedded-agent-helpers.js";
import type { EmbeddedAgentExecutionPhase } from "../embedded-agent-runner/execution-phase.js";
import type {
  CurrentInboundPromptContext,
  EmbeddedRunTrigger,
} from "../embedded-agent-runner/run/params.js";
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
  suppressNextUserMessagePersistence?: boolean;
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  onUserMessagePersisted?: (message: PersistedUserTurnMessage) => void | Promise<void>;
  currentInboundEventKind?: InboundEventKind;
  currentInboundContext?: CurrentInboundPromptContext;
  inputProvenance?: InputProvenance;
  provider: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  lane?: string;
  jobId?: string;
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  silentReplyPromptMode?: SilentReplyPromptMode;
  allowEmptyAssistantReplyAsSilent?: boolean;
  /** Static portion of extraSystemPrompt (excluding per-message inbound metadata) for session reuse hashing. */
  extraSystemPromptStatic?: string;
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
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  skillsSnapshot?: SkillSnapshot;
  messageChannel?: string;
  messageProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentInboundAudio?: boolean;
  agentAccountId?: string;
  /** Trusted sender identity bit for channel action auth. */
  senderIsOwner?: boolean;
  /** Runtime tool allow-list. CLI harnesses fail closed when this is set. */
  toolsAllow?: string[];
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
};

/** Backend config after MCP, skill, env, and cleanup preparation. */
export type CliPreparedBackend = {
  backend: CliBackendConfig;
  cleanup?: () => Promise<void>;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
  env?: Record<string, string>;
};

/** Reusable CLI session id and the reason it was rejected, when any. */
export type CliReusableSession = {
  sessionId?: string;
  invalidatedReason?:
    | "auth-profile"
    | "auth-epoch"
    | "system-prompt"
    | "cwd"
    | "mcp"
    | "missing-transcript"
    | "orphaned-tool-use";
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
  promptToolNamesHash?: string;
  cwdHash?: string;
};
