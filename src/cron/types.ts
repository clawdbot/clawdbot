/** Cron scheduling, delivery, diagnostics, and store data contracts. */
import type { FailoverReason } from "../agents/embedded-agent-helpers/types.js";
import type { EmbeddedAgentExecutionPhase } from "../agents/embedded-agent-runner/execution-phase.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { HookExternalContentSource } from "../security/external-content.js";
import type { CronJobBase } from "./types-shared.js";

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
    };

/** Runtime target that decides whether a job joins main, isolated, or a named session. */
export type CronSessionTarget = "main" | "isolated" | "current" | `session:${string}`;

/** Wake policy for main-session jobs waiting on heartbeat/user activity. */
export type CronWakeMode = "next-heartbeat" | "now";

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
export type CronCompletionDestination = {
  mode: "webhook";
  to?: string;
};

/** Destination override for failed-run notifications. */
export type CronFailureDestination = {
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};

/** Partial failure-destination update shape; null clears individual override fields. */
export type CronFailureDestinationPatch = {
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
export type CronUsageSummary = {
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

/** Execution result persisted on cron state, run logs, and isolated turn results. */
export type CronRunOutcome = {
  status: CronRunStatus;
  error?: string;
  /** Optional classifier for execution errors to guide fallback behavior. */
  errorKind?: "delivery-target";
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  diagnostics?: CronRunDiagnostics;
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
  /** @deprecated Use phase-specific execution milestones for watchdog progress. */
  firstModelCallStarted?: boolean;
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

/** Payload variants cron can execute in main-session or detached modes. */
export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | CronAgentTurnPayload
  | CronCommandPayload;

/** Partial payload update shape used by cron patch/edit flows. */
export type CronPayloadPatch =
  | { kind: "systemEvent"; text?: string }
  | CronAgentTurnPayloadPatch
  | CronCommandPayloadPatch;

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
  /** Optional tool allow-list; when set, only these tools are sent to the model. */
  toolsAllow?: string[];
};

type CronAgentTurnPayload = {
  kind: "agentTurn";
} & CronAgentTurnPayloadFields;

type CronAgentTurnPayloadPatch = {
  kind: "agentTurn";
} & Partial<Omit<CronAgentTurnPayloadFields, "model" | "toolsAllow">> & {
    model?: string | null;
    toolsAllow?: string[] | null;
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
/** Mutable runtime state persisted beside the immutable cron job spec. */
export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  /** Preferred execution outcome field. */
  lastRunStatus?: CronRunStatus;
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

/** Fully persisted cron job with spec fields and mutable run state. */
export type CronJob = CronJobBase<
  CronSchedule,
  CronSessionTarget,
  CronWakeMode,
  CronPayload,
  CronDelivery,
  CronFailureAlert | false
> & {
  state: CronJobState;
};

/** Versioned cron store file shape. */
export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

/** Create input accepted by cron APIs before id/timestamps/state are assigned. */
export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>;
};

/** Patch input accepted by cron APIs without allowing immutable identity fields. */
export type CronJobPatch = Partial<
  Omit<CronJob, "id" | "createdAtMs" | "state" | "payload" | "delivery">
> & {
  payload?: CronPayloadPatch;
  delivery?: CronDeliveryPatch;
  state?: Partial<CronJobState>;
};
