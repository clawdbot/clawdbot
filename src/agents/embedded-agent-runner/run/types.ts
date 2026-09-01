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
import type { AgentHarnessTaskRuntimeScope } from "../../../tasks/agent-harness-task-runtime-scope.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import type { AgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { ToolOutcomeObserver } from "../../agent-tools.before-tool-call.js";
import type { AuthProfileStore } from "../../auth-profiles/types.js";
import type { DelegationCapability } from "../../delegation-capability.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../../embedded-agent-messaging.types.js";
import type { AgentHarnessRuntimeArtifactBinding } from "../../harness/runtime-artifact.types.js";
import type { McpConnectAction } from "../../mcp-connect-action.js";
import type { McpAppChannelView } from "../../mcp-ui-resource.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import type { AgentRunTimeoutPhase } from "../../run-timeout-attribution.js";
import type { AgentRuntimeModelAttempt, AgentRuntimePlan } from "../../runtime-plan/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { SandboxContext } from "../../sandbox/types.js";
import type { AuthStorage, ModelRegistry } from "../../sessions/index.js";
import type { ToolEffectReceipt } from "../../tool-effect-receipt.js";
import type { ToolErrorSummary } from "../../tool-error-summary.js";
import type { NormalizedUsage } from "../../usage.js";
import type { EmbeddedRunReplayMetadata, EmbeddedRunReplayState } from "../replay-state.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import type { DeferredEmbeddedRunLifecycleOwner } from "./deferred-lifecycle-owner.js";
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
  | "preparedRunAdmission"
  | "admittedRunContext"
>;

type EmbeddedRunContextWindowInfo = {
  tokens: number;
  referenceTokens?: number;
  source: "model" | "modelsConfig" | "agentContextTokens" | "default";
};

export type EmbeddedRunFastModeParam = boolean | (() => boolean | undefined);

type EmbeddedRunAttemptOperation = "attempt" | "settled-tool-finalization";

type EmbeddedRunAttemptToolTerminalObservation = {
  toolCallId?: string;
  toolName: string;
  arguments?: unknown;
  meta?: string;
  executionStarted?: boolean;
  /** Exact-instance replay classification resolved by the host tool catalog. */
  replaySafe?: boolean;
  outcome: "success" | "failure";
  failure?: Omit<ToolErrorSummary, "toolName" | "meta" | "mutatingAction">;
  /** Protocol-owned mutation facts for native tools that do not use OpenClaw definitions. */
  nativeMutation?: {
    mutatingAction: boolean;
    replaySafe: boolean;
  };
  /** Concrete plugin owner; the terminal observer derives mutation facts from executed args. */
  ownerMutation?: {
    ownerKey: string;
  };
};

type EmbeddedRunAttemptToolTerminalResolution = {
  lastToolError?: ToolErrorSummary;
  executionStarted: boolean;
  executedArguments?: Record<string, unknown>;
  sideEffectEvidence: boolean;
  effectReceipt: ToolEffectReceipt;
};

type EmbeddedRunAttemptToolTerminalObserver = (
  observation: EmbeddedRunAttemptToolTerminalObservation,
) => EmbeddedRunAttemptToolTerminalResolution;

/** Host-owned trajectory recorder supplied to plugin harnesses for attempt-local runtime events. */
export type EmbeddedRunAttemptTrajectoryRecorder = {
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

export type EmbeddedRunAttemptParams = EmbeddedRunAttemptBase & {
  admittedRunContext: NonNullable<RunEmbeddedAgentParams["admittedRunContext"]>;
  /** Host-private bounded recovery state for this exact attempt. */
  codeModeRecovery?: Exclude<
    import("./terminal-retry-state.js").CodeModeRecoveryState,
    { kind: "idle" }
  >;
  /**
   * Run-owned start timestamp captured by the embedded-run orchestrator before
   * admission. Flows onto the queue handle so recovery can project the active
   * run's authoritative start time instead of the session's subagent first-run.
   */
  startedAtMs?: number;
  /** Explicit session owner captured before fallback agent resolution. */
  contextEngineAgentId?: string;
  /** Host-resolved sandbox snapshot for plugin harness tool construction. */
  sandbox?: SandboxContext | null;
  /** Host-created authority available only after harness selection. */
  hostCapabilities?: import("../../harness/host-capability-types.js").AgentHarnessHostCapabilities;
  /** Sticky operation identity used to suppress ordinary retry and hook policy. */
  operation?: EmbeddedRunAttemptOperation;
  /** Core-prepared fact that explicit requester/config policy restricts plugin-native tools. */
  pluginHarnessToolPolicyRestricted?: boolean;
  /** Audited exact denies that the plugin harness must enforce against native equivalents. */
  pluginHarnessToolPolicySafeDeniedTools?: readonly string[];
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  /** Active file-backed artifact target resolved by the run/session target seam. */
  sessionFile: string;
  initialReplayState?: EmbeddedRunReplayState;
  /** Pluggable context engine for ingest/assemble/compact lifecycle. */
  contextEngine?: ContextEngine;
  /** Resolved model context window in tokens for assemble/compact budgeting. */
  contextTokenBudget?: number;
  /** Per-model contextTokens cap authored by the operator; absent when none was authored. */
  authoredContextTokenCap?: number;
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
  /** Whether this attempt may start or redirect work to another agent/task. */
  delegationCapability?: DelegationCapability;
  /** Concrete degraded-runtime reason for this attempt, when known. */
  degradedReason?: string | null;
  /** Session-pinned embedded harness id. Prevents runtime hot-switching. */
  agentHarnessId?: string;
  /** Capture a local harness implementation only for setup/verified continuations. */
  captureRuntimeArtifact?: boolean;
  /** Exact implementation that must own the attempt before it creates a native thread. */
  expectedRuntimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  /** OpenClaw-owned runtime policy prepared by the orchestrator for this attempt. */
  runtimePlan?: AgentRuntimePlan;
  /** Reports terminal tool facts to the host-owned attempt outcome accumulator. */
  observeToolTerminal?: EmbeddedRunAttemptToolTerminalObserver;
  /** Host-issued scope for harnesses that mirror native child runs into task state. */
  agentHarnessTaskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  /** Storage-aware trajectory recorder owned by the OpenClaw host. */
  trajectoryRecorder?: EmbeddedRunAttemptTrajectoryRecorder | null;
  /** Live observer called after wrapped tool outcomes are recorded. */
  onToolOutcome?: ToolOutcomeObserver;
  /** Reads the sticky untrusted-content flag for the current user turn. */
  isTurnTainted?: () => boolean;
  /** Signals that the attempt's own run-timeout watchdog is active. */
  onAttemptTimeoutArmed?: () => void;
  /** Signals that this attempt's timeout has fired and must unwind promptly. */
  onAttemptTimeout?: (reason: Error) => void;
  /** Signals an explicit cancellation through the active native run handle. */
  onAttemptAbort?: () => void;
  onDeferredLifecycleOwner?: (owner: DeferredEmbeddedRunLifecycleOwner) => void;
  onDeferredLifecycleAbort?: (reason?: "user_abort" | "restart" | "superseded") => void;
  /** Run-owned permission changes survive native attempt replacement, never user cancellation. */
  permissionChange?: {
    readonly owner: object;
    readonly baseExecOverrides: Readonly<NonNullable<RunEmbeddedAgentParams["execOverrides"]>>;
    readonly notice?: string;
    request: (
      mode: NonNullable<RunEmbeddedAgentParams["permissionMode"]> | null,
    ) => Promise<boolean>;
    /** False means a newer permission request superseded this prepared attempt. */
    applied: () => boolean;
    recordApplied: (mode: NonNullable<RunEmbeddedAgentParams["permissionMode"]> | null) => void;
  };
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
  beforeAgentFinalizeRevisionAttempts?: number;
  maxBeforeAgentFinalizeRevisions?: number;
};

export type EmbeddedRunAttemptResult = {
  terminal: AgentRunAttemptTerminal;
  /** True when the runtime made the authoritative final-assistant transcript decision. */
  assistantTranscriptOwned?: boolean;
  /** Exact idempotency key for the runtime-owned final-assistant transcript row. */
  assistantTranscriptIdempotencyKey?: string;
  /** Host-private terminal identity used to close the accepted transcript turn. */
  contextEngineTerminalAnchor?: import("../../../config/sessions/transcript-entry-anchor.js").TranscriptEntryAnchor;
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
  /** Current physical model attempt; replaced from the prepared runtime plan at the boundary. */
  modelAttempt?: AgentRuntimeModelAttempt;
  /** Exact credential material fingerprint reported by a harness-owned auth boundary. */
  authBindingFingerprint?: string;
  /** Exact local implementation used by a plugin-owned harness attempt. */
  runtimeArtifact?: AgentHarnessRuntimeArtifactBinding;
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
    transport: "stdio" | "unix" | "websocket";
    threadId?: string;
    turnId?: string;
    replaySafe: boolean;
    replayBlockedReason?:
      | "assistant_output"
      | "tool_activity"
      | "potential_side_effect"
      | "active_item";
    diagnostics?: {
      transportError?: string;
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
  /** Exact provider-response count when the harness can observe model iterations directly. */
  modelIterations?: number;
  /** Saved provider retry setting resolved by the prepared session owner. */
  providerRetryMaxRetries?: number;
  messagesSnapshot: AgentMessage[];
  /** Owner-eligible settled finalization, with frozen evidence or an unavailable projection. */
  settledTurnFinalizationContext?:
    | { readonly source: "openclaw-transcript"; readonly messages: readonly AgentMessage[] }
    | { readonly source: "harness"; readonly data: unknown }
    | { readonly source: "unavailable" };
  beforeAgentFinalizeRevisionReason?: string;
  assistantTexts: string[];
  latestMcpAppChannelView?: McpAppChannelView;
  latestMcpConnectAction?: McpConnectAction;
  lastAssistantTextMessageIndex?: number;
  toolMetas: Array<{
    toolName: string;
    toolCallId?: string;
    meta?: string;
    replaySafe?: boolean;
    isError?: boolean;
    terminate?: boolean;
    asyncStarted?: boolean;
    asyncTaskRunId?: string;
    asyncTaskId?: string;
    /** Producer-recorded: this exec result parked a Code Mode run (status "waiting"). */
    codeModeSuspended?: boolean;
  }>;
  acceptedSessionSpawns?: AcceptedSessionSpawn[];
  /** This attempt accepted work whose future output has a runtime-owned delivery path. */
  runtimeContinuationStarted?: boolean;
  lastAssistant: AssistantMessage | undefined;
  /**
   * Omission preserves the legacy `lastAssistant` fallback; explicit `undefined`
   * means this attempt produced no assistant response.
   */
  currentAttemptAssistant?: AssistantMessage | undefined;
  /** Completed message_end snapshot owned by this model attempt. */
  currentAttemptCompletedAssistant?: AssistantMessage | undefined;
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
  /**
   * Native artifacts produced and owned by the harness, never model-selected
   * dynamic-tool output. Core validates this as a subset of toolMediaUrls.
   */
  hostOwnedToolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  toolTrustedLocalMedia?: boolean;
  hasToolMediaBlockReply?: boolean;
  successfulCronAdds?: number;
  cloudCodeAssistFormatError: boolean;
  /** Effective context window reported by the harness during this attempt. */
  contextTokens?: number;
  /** Whether the harness observed the window or carried prepared resolution forward. */
  contextTokensSource?: "runtime" | "runtime-configured" | "resolved";
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
  /** Explicit user-facing waiting status supplied to sessions_yield. */
  yieldAcknowledgment?: string;
  /**
   * True when code mode owned this attempt's model tool surface. Absent means
   * the harness did not report engagement (treated as not engaged), which is
   * how config-enabled code mode stays visible as a no-op on harness routes.
   */
  codeModeEngaged?: boolean;
  /** Host-authenticated facts for bounded post-mutation inspection and recovery. */
  codeModeRecoveryCandidate?: import("./terminal-retry-state.js").CodeModeRecoveryCandidate;
  /** Completed assistant round trips observed during this attempt. */
  assistantTurns?: number;
  /** Inner bridge call counts from this attempt's tool-search/code-mode catalog. */
  bridgeCalls?: {
    search: number;
    describe: number;
    call: number;
  };
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
