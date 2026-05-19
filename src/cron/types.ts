/** Cron scheduling, delivery, diagnostics, and store data contracts. */
import type { FailoverReason } from "../agents/embedded-agent-helpers/types.js";
import type { EmbeddedAgentExecutionPhase } from "../agents/embedded-agent-runner/execution-phase.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { HookExternalContentSource } from "../security/external-content.js";
import type { CronScheduledToolPolicy } from "./scheduled-tool-policy.js";
import type { CronJobBase, CronPacing } from "./types-shared.js";

export type { CronPacing } from "./types-shared.js";

/** Supported schedule forms persisted in cron job specs. */
export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | {
      kind: "cron";
      expr: string;
      tz?: string;
      /** Optional deterministic stagger window in milliseconds (0 keeps exact schedule). */
      staggerMs?: number;
    }
  | {
      /**
       * Event-driven (non-time) trigger: the job fires once when a gateway-owned
       * watcher process running `command` exits. The watcher lives under the
       * gateway ProcessSupervisor, NOT inside any agent turn's process tree, so
       * it survives the per-turn spawn-and-kill teardown that CLI backends apply
       * (#71662). On exit the job runs through the normal cron run pipeline, so
       * delivery to the bound session works exactly like a scheduled main job.
       * `computeNextRunAtMs` returns undefined for this kind (never time-due).
       */
      kind: "on-exit";
      command: string;
      cwd?: string;
    }
  | {
      /** Event-driven source whose supervised argv emits payload-triggering lines. */
      kind: "stream";
      command: string[];
      cwd?: string;
      mode?: "line" | "match";
      /** JavaScript regular-expression source, required when mode is "match". */
      match?: string;
      batchMs?: number;
      maxBatchBytes?: number;
    };

/** Runtime target that decides whether a job joins main, isolated, or a named session. */
type CronSessionTarget = "main" | "isolated" | "current" | `session:${string}`;

/** Wake policy for main-session jobs waiting on heartbeat/user activity. */
type CronWakeMode = "next-heartbeat" | "now";

/** Messaging channel id accepted by cron delivery settings. */
export type CronMessageChannel = ChannelId;

/** Delivery mode for job completion output. */
export type CronDeliveryMode = "none" | "announce" | "webhook";

/** Completion delivery configuration for cron job output. */
export type CronDelivery = {
  mode: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string;
  /** Explicit thread/topic id for channels that support threaded delivery. */
  threadId?: string | number;
  /** Explicit channel account id for multi-account setups (e.g. multiple Telegram bots). */
  accountId?: string;
  bestEffort?: boolean;
  /** Additional webhook destination used when a job must keep chat delivery. */
  completionDestination?: CronCompletionDestination;
  /** Separate destination for failure notifications. */
  failureDestination?: CronFailureDestination;
};

/** Webhook completion destination used alongside chat delivery. */
type CronCompletionDestination = {
  mode: "webhook";
  to?: string;
};

/** Destination override for failed-run notifications. */
type CronFailureDestination = {
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};

/** Partial failure-destination update shape; null clears individual override fields. */
type CronFailureDestinationPatch = {
  channel?: CronMessageChannel | null;
  to?: string | null;
  accountId?: string | null;
  mode?: "announce" | "webhook" | null;
};

/** Partial delivery update shape; null clears optional delivery destinations or fields. */
export type CronDeliveryPatch = Partial<Pick<CronDelivery, "mode" | "bestEffort">> & {
  channel?: CronMessageChannel | null;
  to?: string | null;
  threadId?: string | number | null;
  accountId?: string | null;
  completionDestination?: CronCompletionDestination | null;
  failureDestination?: CronFailureDestinationPatch | null;
};

/** Execution outcome, separate from delivery outcome. */
export type CronRunStatus = "ok" | "error" | "skipped";

/** Delivery outcome for completion or failure-notification sends. */
export type CronDeliveryStatus = "delivered" | "not-delivered" | "unknown" | "not-requested";

/** Delivery target snapshot recorded for audit/debug output. */
export type CronDeliveryTraceTarget = {
  channel?: string;
  to?: string | null;
  accountId?: string;
  threadId?: string | number;
  source?: "explicit" | "last";
};

/** Message-tool target that already sent to the cron delivery destination. */
export type CronDeliveryTraceMessageTarget = {
  channel: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

/** Trace of intended, resolved, and already-sent delivery decisions for one run. */
export type CronDeliveryTrace = {
  intended?: CronDeliveryTraceTarget;
  resolved?: CronDeliveryTraceTarget & { ok: boolean; error?: string };
  messageToolSentTo?: CronDeliveryTraceMessageTarget[];
  fallbackUsed?: boolean;
  delivered?: boolean;
};

/** Last failed-run notification delivery state stored on job state and run logs. */
export type CronFailureNotificationDelivery = {
  /** Whether the last failed run's failure notification reached the target channel. */
  delivered?: boolean;
  status: CronDeliveryStatus;
  error?: string;
};

/** Human-readable delivery target preview for list/detail surfaces. */
export type CronDeliveryPreview = {
  label: string;
  detail: string;
};

/** Token usage summary copied from the agent runner when available. */
type CronUsageSummary = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};

/** Model/provider/usage telemetry attached to cron run results and logs. */
export type CronRunTelemetry = {
  model?: string;
  provider?: string;
  usage?: CronUsageSummary;
};

/** Severity level for persisted cron run diagnostics. */
export type CronRunDiagnosticSeverity = "info" | "warn" | "error";

/** Subsystem that produced a cron run diagnostic entry. */
export type CronRunDiagnosticSource =
  | "cron-preflight"
  | "cron-setup"
  | "model-preflight"
  | "agent-run"
  | "tool"
  | "exec"
  | "delivery";

/** Timestamped diagnostic entry preserved for cron run troubleshooting. */
export type CronRunDiagnostic = {
  ts: number;
  source: CronRunDiagnosticSource;
  severity: CronRunDiagnosticSeverity;
  message: string;
  toolName?: string;
  exitCode?: number | null;
  truncated?: boolean;
};

/** Bounded diagnostic bundle stored on the run outcome. */
export type CronRunDiagnostics = {
  summary?: string;
  entries: CronRunDiagnostic[];
};

/** Explicit execution-error disposition used consistently by retry, history, and alerts. */
export type CronRunErrorClassification =
  | { kind: "reason"; reason: FailoverReason }
  | { kind: "permanent" };

/** Execution result persisted on cron state, run logs, and isolated turn results. */
export type CronRunOutcome = {
  status: CronRunStatus;
  error?: string;
  /** True once agent execution begins; retries after this point can replay side effects. */
  executionStarted?: boolean;
  /** Optional classifier for execution errors to guide fallback behavior. */
  errorKind?: "delivery-target";
  errorClassification?: CronRunErrorClassification;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  diagnostics?: CronRunDiagnostics;
};

/** One run's requested delay before the same paced job runs again. */
export type CronNextCheckProposal = {
  delayMs: number;
};

/** Embedded-agent execution phase names surfaced to cron watchdog progress. */
export type CronAgentExecutionPhase = EmbeddedAgentExecutionPhase;

/** Watchdog-visible execution metadata for an in-flight cron agent run. */
export type CronAgentExecutionStarted = {
  jobId: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  phase?: CronAgentExecutionPhase;
  provider?: string;
  model?: string;
  backend?: string;
  source?: string;
  tool?: string;
  toolCallId?: string;
  itemId?: string;
};

/** Watchdog update that requires the new execution phase. */
export type CronAgentExecutionPhaseUpdate = CronAgentExecutionStarted & {
  phase: CronAgentExecutionPhase;
};

/** Failure alert policy persisted on a cron job. */
export type CronFailureAlert = {
  after?: number;
  channel?: CronMessageChannel;
  to?: string;
  cooldownMs?: number;
  /** When true, consecutive skipped runs count toward the alert threshold. */
  includeSkipped?: boolean;
  /** Delivery mode: announce (via messaging channels) or webhook (HTTP POST). */
  mode?: "announce" | "webhook";
  /** Account ID for multi-account channel configurations. */
  accountId?: string;
};

/** Partial failure-alert update; null clears an inherited field override. */
export type CronFailureAlertPatch = {
  [K in keyof CronFailureAlert]?: CronFailureAlert[K] | null;
};

/** Payload variants cron can execute in main-session or detached modes. */
export type CronPayload =
  | ({ kind: "systemEvent"; text: string } & CronPayloadToolAllow)
  | (CronAgentTurnPayload & CronPayloadToolAllow)
  | (CronCommandPayload & CronPayloadToolAllow)
  | (CronScriptPayload & CronPayloadToolAllow)
  // System-owned heartbeat monitor: execution requests an interval heartbeat
  // wake. Gateway-converged only; not accepted from client create/patch APIs.
  | ({ kind: "heartbeat" } & CronPayloadToolAllow);

/** Partial payload update shape used by cron patch/edit flows. */
export type CronPayloadPatch =
  | ({ kind: "systemEvent"; text?: string } & CronPayloadToolAllowPatch)
  | (CronAgentTurnPayloadPatch & CronPayloadToolAllowPatch)
  | (CronCommandPayloadPatch & CronPayloadToolAllowPatch)
  | (CronScriptPayloadPatch & CronPayloadToolAllowPatch)
  // Representable so the service can reject it with a typed boundary error;
  // transports and tools never accept it.
  | ({ kind: "heartbeat" } & CronPayloadToolAllowPatch);

type CronPayloadToolAllow = {
  /** Restricts agentTurn execution, or the trigger runtime for other payload kinds. */
  toolsAllow?: string[];
  /** Server-managed marker for auto-stamped defaults; explicit restrictions omit it. */
  toolsAllowIsDefault?: boolean;
};

type CronPayloadToolAllowPatch = {
  toolsAllow?: string[] | null;
  toolsAllowIsDefault?: boolean;
};

type CronAgentTurnPayloadFields = {
  message: string;
  /** Optional model override (provider/model or alias). */
  model?: string;
  /** Optional per-job fallback models; overrides agent/global fallbacks when defined. */
  fallbacks?: string[];
  thinking?: string;
  timeoutSeconds?: number;
  allowUnsafeExternalContent?: boolean;
  /** Immutable external hook provenance for async dispatch. */
  externalContentSource?: HookExternalContentSource;
  /** If true, run with lightweight bootstrap context. */
  lightContext?: boolean;
};

type CronAgentTurnPayload = {
  kind: "agentTurn";
} & CronAgentTurnPayloadFields;

type CronAgentTurnPayloadPatch = {
  kind: "agentTurn";
} & Partial<Omit<CronAgentTurnPayloadFields, "model" | "fallbacks" | "toolsAllow" | "thinking">> & {
    model?: string | null;
    fallbacks?: string[] | null;
    toolsAllow?: string[] | null;
    thinking?: string | null;
  };

type CronCommandPayloadFields = {
  /** Explicit argv vector to execute. Use a shell wrapper argv for shell syntax. */
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  timeoutSeconds?: number;
  noOutputTimeoutSeconds?: number;
  outputMaxBytes?: number;
};

type CronCommandPayload = {
  kind: "command";
} & CronCommandPayloadFields;

type CronCommandPayloadPatch = {
  kind: "command";
} & Partial<CronCommandPayloadFields>;

type CronScriptPayloadFields = {
  script: string;
  timeoutSeconds?: number;
  toolBudget?: number;
};

type CronScriptPayload = {
  kind: "script";
} & CronScriptPayloadFields;

type CronScriptPayloadPatch = {
  kind: "script";
} & Partial<CronScriptPayloadFields>;
/** Mutable runtime state persisted beside the immutable cron job spec. */
export type CronJobState = {
  nextRunAtMs?: number;
  /** Exact startup catch-up slot protected from future-slot repair across restarts. */
  startupCatchupAtMs?: number;
  /** Exact paced completion slot protected from future-slot repair until consumed. */
  pacedNextRunAtMs?: number;
  /** Exact recurring slot retained across an out-of-band manual force run. */
  forcePreservedNextRunAtMs?: number;
  /** Durable pre-admission reservation. Cleared on restart without recording a run. */
  queuedAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  /** Preferred execution outcome field. */
  lastRunStatus?: CronRunStatus;
  /** Whether the last run was triggered manually (via `cron run`). */
  lastRunWasManual?: boolean;
  /** @deprecated Use lastRunStatus. */
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDiagnostics?: CronRunDiagnostics;
  lastDiagnosticSummary?: string;
  /** Classified reason for the last error (when available). */
  lastErrorReason?: FailoverReason;
  lastDurationMs?: number;
  /** Number of consecutive execution errors (reset on success). Used for backoff. */
  consecutiveErrors?: number;
  /** Number of consecutive skipped executions (reset on success or error). */
  consecutiveSkipped?: number;
  /** Last failure alert timestamp (ms since epoch) for cooldown gating. */
  lastFailureAlertAtMs?: number;
  /** Number of consecutive schedule computation errors. Auto-disables job after threshold. */
  scheduleErrorCount?: number;
  /** Timestamp of the last trigger script evaluation. */
  lastTriggerEvalAtMs?: number;
  /** Number of completed trigger script evaluations. */
  triggerEvalCount?: number;
  /** Timestamp of the last trigger evaluation that fired. */
  lastTriggerFireAtMs?: number;
  /** JSON state returned by the last trigger script evaluation. */
  triggerState?: unknown;
  /** Current gateway-owned stream source lifecycle state. */
  streamStatus?: "starting" | "running" | "restarting" | "stopped" | "disabled" | "error";
  streamError?: string;
  streamConsecutiveFailures?: number;
  streamRestartExhausted?: boolean;
  // Identity of the logical stream source that owns this job's batches. It is
  // stable across child-process restarts and rotates atomically when the source
  // is disabled, removed, or replaced, closing same-schedule ABA admission.
  streamSourceIdentity?: string;
  streamDroppedBatches?: number;
  streamCoalescedBatches?: number;
  streamLastStartedAtMs?: number;
  streamLastExitAtMs?: number;
  /** Explicit delivery outcome, separate from execution outcome. */
  lastDeliveryStatus?: CronDeliveryStatus;
  /** Delivery-specific error text when available. */
  lastDeliveryError?: string;
  /** Whether the last run's output was delivered to the target channel. */
  lastDelivered?: boolean;
  /** Whether the last failed run's failure notification was delivered to the target channel. */
  lastFailureNotificationDelivered?: boolean;
  /** Delivery outcome for the last failed run's failure notification. */
  lastFailureNotificationDeliveryStatus?: CronDeliveryStatus;
  /** Delivery-specific error for the last failed run's failure notification. */
  lastFailureNotificationDeliveryError?: string;
};

export type CronTrigger = {
  script: string;
  once?: boolean;
};

/**
 * Closed failure taxonomy for trigger-script evaluation. Mirrors the code-mode
 * failure codes plus the trigger tool budget; trigger-script.ts asserts the
 * union stays in sync at compile time. Lives here (leaf module) so the cron
 * service contract never imports the agents runtime.
 */
export type CronTriggerFailureCode =
  | "aborted"
  | "invalid_input"
  | "runtime_unavailable"
  | "timeout"
  | "output_limit_exceeded"
  | "snapshot_limit_exceeded"
  | "internal_error"
  | "tool_budget_exceeded";

/** Result union returned by the cron trigger-script evaluator. */
export type CronTriggerEvaluationResult =
  | { kind: "evaluated"; fire: boolean; message?: string; state?: unknown }
  | { kind: "busy" }
  | { kind: "error"; code: CronTriggerFailureCode; error: string };

/** Fully persisted cron job with spec fields and mutable run state. */
export type CronJob = CronJobBase<
  CronSchedule,
  CronSessionTarget,
  CronWakeMode,
  CronPayload,
  CronDelivery,
  CronFailureAlert | false
> & {
  declarationKey?: string;
  displayName?: string;
  owner?: {
    agentId?: string;
    sessionKey?: string;
    /** Authenticated account that created this scheduled authority envelope. */
    accountId?: string;
  };
  /** Server-authored provenance for requester-scoped scheduled tool authority. */
  scheduledToolPolicy?: CronScheduledToolPolicy;
  trigger?: CronTrigger;
  state: CronJobState;
};

/** Versioned cron store file shape. */
export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

type CronJobStateInput = Partial<Omit<CronJobState, "streamSourceIdentity">>;

/** Create input accepted by cron APIs before id/timestamps/state are assigned. */
export type CronJobCreate = Omit<
  CronJob,
  "id" | "createdAtMs" | "updatedAtMs" | "state" | "scheduledToolPolicy"
> & {
  /** Internal callers can reserve a durable id before creation; public cron.add omits this. */
  id?: string;
  state?: CronJobStateInput;
};

/** Patch input accepted by cron APIs without allowing immutable identity fields. */
export type CronJobPatch = Partial<
  Omit<
    CronJob,
    | "id"
    | "createdAtMs"
    | "state"
    | "payload"
    | "delivery"
    | "failureAlert"
    | "declarationKey"
    | "displayName"
    | "owner"
    | "scheduledToolPolicy"
    | "pacing"
  >
> & {
  displayName?: string | null;
  pacing?: CronPacing | null;
  trigger?: CronTrigger | null;
  payload?: CronPayloadPatch;
  delivery?: CronDeliveryPatch;
  failureAlert?: CronFailureAlertPatch | false | null;
  state?: CronJobStateInput;
};
