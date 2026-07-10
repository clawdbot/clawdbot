/**
 * Shared result and attempt types for embedded-agent run internals.
 */
import type { HeartbeatToolResponse } from "../../../auto-reply/heartbeat-tool-response.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type {
  SessionContextBudgetStatus,
  SessionSystemPromptReport,
} from "../../../config/sessions/types.js";
import type { ContextEngine, ContextEnginePromptCacheInfo } from "../../../context-engine/types.js";
import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { AssistantMessage, Model } from "../../../llm/types.js";
import type { PluginHookBeforeAgentStartResult } from "../../../plugins/hook-before-agent-start.types.js";
import type { AgentHarnessTaskRuntimeScope } from "../../../tasks/agent-harness-task-runtime-scope.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import type { ToolOutcomeObserver } from "../../agent-tools.before-tool-call.js";
import type { AuthProfileStore } from "../../auth-profiles/types.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../../embedded-agent-messaging.types.js";
import type { AgentRunTimeoutPhase } from "../../run-timeout-attribution.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AuthStorage, ModelRegistry } from "../../sessions/index.js";
import type { ToolErrorSummary } from "../../tool-error-summary.js";
import type { NormalizedUsage } from "../../usage.js";
import type { EmbeddedRunReplayMetadata, EmbeddedRunReplayState } from "../replay-state.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

type EmbeddedRunAttemptBase = Omit<
  RunEmbeddedAgentParams,
  | "provider"
  | "model"
  | "authProfileId"
  | "authProfileIdSource"
  | "thinkLevel"
  | "fastMode"
  | "lane"
  | "enqueue"
  | "sessionFile"
>;

type EmbeddedRunContextWindowInfo = {
  tokens: number;
  referenceTokens?: number;
  source: "model" | "modelsConfig" | "agentContextTokens" | "default";
};

export type EmbeddedRunFastModeParam = boolean | (() => boolean | undefined);

export type EmbeddedRunAttemptParams = EmbeddedRunAttemptBase & {
  /** Active file-backed artifact target resolved by the run/session target seam. */
  sessionFile: string;
  initialReplayState?: EmbeddedRunReplayState;
  /** Pluggable context engine for ingest/assemble/compact lifecycle. */
  contextEngine?: ContextEngine;
  /** Resolved model context window in tokens for assemble/compact budgeting. */
  contextTokenBudget?: number;
  /** Source metadata for the resolved model context budget. */
  contextWindowInfo?: EmbeddedRunContextWindowInfo;
  /** Resolved API key for this run when runtime auth did not replace it. */
  resolvedApiKey?: string;
  /** Auth profile resolved for this attempt's provider/model call. */
  authProfileId?: string;
  /** Source for the resolved auth profile (user-locked or automatic). */
  authProfileIdSource?: "auto" | "user";
  provider: string;
  modelId: string;
  /** Operator-requested or initial model id before any fallback resolution. */
  requestedModelId?: string | null;
  /** True when this attempt is running after a model fallback decision. */
  fallbackActive?: boolean;
  /** Concrete fallback reason that selected this attempt, when known. */
  fallbackReason?: string | null;
  /** Concrete degraded-runtime reason for this attempt, when known. */
  degradedReason?: string | null;
  /** Session-pinned embedded harness id. Prevents runtime hot-switching. */
  agentHarnessId?: string;
  /** OpenClaw-owned runtime policy prepared by the orchestrator for this attempt. */
  runtimePlan?: AgentRuntimePlan;
  /** Host-issued scope for harnesses that mirror native child runs into task state. */
  agentHarnessTaskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  /** Live observer called after wrapped tool outcomes are recorded. */
  onToolOutcome?: ToolOutcomeObserver;
  /** Signals that the attempt's own run-timeout watchdog is active. */
  onAttemptTimeoutArmed?: () => void;
  /** Signals that this attempt's timeout has fired and must unwind promptly. */
  onAttemptTimeout?: (reason: Error) => void;
  /** Signals an explicit cancellation through the active native run handle. */
  onAttemptAbort?: () => void;
  /** Supplies run-global model-call ordering for parallel tool outcomes. */
  allocateToolOutcomeOrdinal?: (toolCallId?: string) => number;
  model: Model;
  authStorage: AuthStorage;
  /** Auth profile store already resolved during startup for this attempt. */
  authProfileStore: AuthProfileStore;
  /**
   * Full auth profile store for OpenClaw tool availability.
   * Plugin-owned harnesses may scope `authProfileStore` to model transport credentials.
   */
  toolAuthProfileStore?: AuthProfileStore;
  modelRegistry: ModelRegistry;
  thinkLevel: ThinkLevel;
  fastMode?: EmbeddedRunFastModeParam;
  /** True when this attempt is running the auto fast-mode policy. */
  fastModeAuto?: boolean;
  beforeAgentStartResult?: PluginHookBeforeAgentStartResult;
  beforeAgentFinalizeRevisionAttempts?: number;
  maxBeforeAgentFinalizeRevisions?: number;
};

export type EmbeddedRunAttemptResult = {
  aborted: boolean;
  /** True when the runtime made the authoritative final-assistant transcript decision. */
  assistantTranscriptOwned?: boolean;
  /** True when the abort originated from the caller-provided abortSignal. */
  externalAbort: boolean;
  timedOut: boolean;
  /** True when the no-response LLM idle watchdog caused the timeout. */
  idleTimedOut: boolean;
  /** True if the timeout occurred while compaction was in progress or pending. */
  timedOutDuringCompaction: boolean;
  /** Optional because this type is re-exported as `AgentHarnessAttemptResult`. */
  timedOutDuringToolExecution?: boolean;
  timedOutByRunBudget?: boolean;
  promptError: unknown;
  /**
   * Identifies which phase produced the promptError.
   * - "prompt": the LLM call itself failed and may be eligible for retry/fallback.
   * - "compaction": the prompt succeeded, but waiting for compaction/retry teardown was aborted;
   *   this must not be retried as a fresh prompt or the same tool turn can replay.
   * - "precheck": pre-prompt overflow recovery intentionally short-circuited the prompt so the
   *   outer run loop can recover via compaction/truncation before any model call is made.
   * - "hook:before_agent_run": a lifecycle hook blocked the run before the prompt was sent.
   * - null: no promptError.
   */
  promptErrorSource: "prompt" | "compaction" | "precheck" | "hook:before_agent_run" | null;
  preflightRecovery?:
    | {
        route: Exclude<PreemptiveCompactionRoute, "fits">;
        source?: "mid-turn";
        estimatedPromptTokens?: number;
        promptBudgetBeforeReserve?: number;
        overflowTokens?: number;
        handled: true;
        truncatedCount?: number;
      }
    | {
        route: Exclude<PreemptiveCompactionRoute, "fits">;
        source?: "mid-turn";
        estimatedPromptTokens?: number;
        promptBudgetBeforeReserve?: number;
        overflowTokens?: number;
        handled?: false;
      };
  sessionIdUsed: string;
  sessionFileUsed?: string;
  diagnosticTrace?: DiagnosticTraceContext;
  agentHarnessId?: string;
  agentHarnessResultClassification?: "empty" | "reasoning-only" | "planning-only";
  promptTimeoutOutcome?: {
    message?: string;
    replayInvalid?: boolean;
    livenessState?: EmbeddedRunLivenessState;
    timeoutPhase?: AgentRunTimeoutPhase;
    providerStarted?: boolean;
  };
  codexAppServerFailure?: {
    kind: "client_closed_before_turn_completed" | "turn_completion_idle_timeout";
    turnWatchTimeoutKind?: "progress" | "completion" | "terminal";
    transport: "stdio" | "websocket";
    threadId?: string;
    turnId?: string;
    replaySafe: boolean;
    replayBlockedReason?:
      | "assistant_output"
      | "tool_activity"
      | "potential_side_effect"
      | "active_item";
    diagnostics?: {
      idleMs?: number;
      timeoutMs?: number;
      lastActivityReason?: string;
      lastNotificationMethod?: string;
      lastNotificationItemId?: string;
      lastNotificationItemType?: string;
      lastNotificationItemRole?: string;
      lastAssistantTextPreview?: string;
      activeAppServerTurnRequests?: number;
      activeTurnItemCount?: number;
      terminalTurnNotificationQueued?: boolean;
      completionIdleWatchArmed?: boolean;
      assistantCompletionIdleWatchArmed?: boolean;
      terminalIdleWatchArmed?: boolean;
    };
  };
  bootstrapPromptWarningSignaturesSeen?: string[];
  bootstrapPromptWarningSignature?: string;
  systemPromptReport?: SessionSystemPromptReport;
  finalPromptText?: string;
  messagesSnapshot: AgentMessage[];
  beforeAgentFinalizeRevisionReason?: string;
  assistantTexts: string[];
  lastAssistantTextMessageIndex?: number;
  toolMetas: Array<{
    toolName: string;
    meta?: string;
    replaySafe?: boolean;
    isError?: boolean;
    asyncStarted?: boolean;
    asyncTaskRunId?: string;
    asyncTaskId?: string;
  }>;
  acceptedSessionSpawns?: AcceptedSessionSpawn[];
  lastAssistant: AssistantMessage | undefined;
  currentAttemptAssistant?: AssistantMessage | undefined;
  lastToolError?: ToolErrorSummary;
  didSendViaMessagingTool: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  toolTrustedLocalMedia?: boolean;
  hasToolMediaBlockReply?: boolean;
  successfulCronAdds?: number;
  cloudCodeAssistFormatError: boolean;
  attemptUsage?: NormalizedUsage;
  promptCache?: ContextEnginePromptCacheInfo;
  contextBudgetStatus?: SessionContextBudgetStatus;
  compactionCount?: number;
  compactionTokensAfter?: number;
  /**
   * Client tool calls detected during this attempt (OpenResponses hosted
   * tools), in the order the underlying LLM emitted them. Field is
   * `undefined` when no client tools were called so existing truthiness
   * checks across the runner pipeline (`attempt.clientToolCalls ? ...`)
   * keep their meaning. When set, the array always has at least one entry.
   */
  clientToolCalls?: Array<{ name: string; params: Record<string, unknown> }>;
  /** True when sessions_yield tool was called during this attempt. */
  yieldDetected?: boolean;
  replayMetadata: EmbeddedRunReplayMetadata;
  /**
   * Replay metadata for this attempt before prior session state is accumulated.
   * Older harnesses may omit it and retain conservative cumulative retry gating.
   */
  currentAttemptReplayMetadata?: EmbeddedRunReplayMetadata;
  itemLifecycle: {
    startedCount: number;
    completedCount: number;
    activeCount: number;
  };
  setTerminalLifecycleMeta?: (meta: {
    replayInvalid?: boolean;
    livenessState?: EmbeddedRunLivenessState;
    stopReason?: string;
    yielded?: boolean;
    timeoutPhase?: AgentRunTimeoutPhase;
    providerStarted?: boolean;
    aborted?: boolean;
  }) => void;
};
