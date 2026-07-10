/** Cron service dependency, event, state, and public result types. */
import type { CronConfig } from "../../config/types.cron.js";
import type { HeartbeatRunResult, HeartbeatWakeRequest } from "../../infra/heartbeat-wake.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { QuarantinedCronConfigJob } from "../store.js";
import type {
  CronTriggerEvaluationResult,
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronFailureNotificationDelivery,
  CronDeliveryStatus,
  CronDeliveryTrace,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronRunDiagnostics,
  CronMessageChannel,
  CronRunOutcome,
  CronRunStatus,
  CronRunTelemetry,
  CronStoreFile,
} from "../types.js";

/** Event payload emitted for cron lifecycle changes and completed runs. */
export type CronEvent = {
  jobId: string;
  action: "added" | "updated" | "removed" | "started" | "finished" | "scheduled";
  /** Snapshot of the job at the time of the event. Present for all actions where the job is accessible. */
  job?: CronJob;
  runAtMs?: number;
  durationMs?: number;
  status?: CronRunStatus;
  error?: string;
  summary?: string;
  diagnostics?: CronRunDiagnostics;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  failureNotificationDelivery?: CronFailureNotificationDelivery;
  delivery?: CronDeliveryTrace;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  nextRunAtMs?: number;
  triggerFired?: boolean;
} & CronRunTelemetry;

/** Logger contract consumed by cron service internals. */
export type Logger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type CronSystemEventEnqueueResult =
  | boolean
  | void
  | {
      accepted?: boolean;
      remove?: () => boolean | void;
    };

/** Dependency injection surface for the cron service runtime. */
export type CronServiceDeps = {
  nowMs?: () => number;
  log: Logger;
  storePath: string;
  cronEnabled: boolean;
  /** CronConfig for session retention settings. */
  cronConfig?: CronConfig;
  evaluateCronTrigger?: (params: {
    job: CronJob;
    script: string;
    state: unknown;
    abortSignal?: AbortSignal;
  }) => Promise<CronTriggerEvaluationResult>;
  /** Default agent id for jobs without an agent id. */
  defaultAgentId?: string;
  /** Resolve session store path for a given agent id. */
  resolveSessionStorePath?: (agentId?: string) => string;
  /** Path to the session store (sessions.json) for reaper use. */
  sessionStorePath?: string;
  /**
   * Delay in ms between missed job executions on startup.
   * Prevents overwhelming the gateway when many jobs are overdue.
   * See: https://github.com/openclaw/openclaw/issues/18892
   */
  missedJobStaggerMs?: number;
  /**
   * Maximum number of missed jobs to run immediately on startup.
   * Additional missed jobs will be rescheduled to fire gradually.
   * See: https://github.com/openclaw/openclaw/issues/18892
   */
  maxMissedJobsPerRestart?: number;
  /**
   * Delay before replaying missed agent-turn jobs found during gateway startup.
   * Keeps model/tool bootstrap work out of the channel connect window.
   */
  startupDeferredMissedAgentJobDelayMs?: number;
  enqueueSystemEvent: (
    text: string,
    opts?: {
      agentId?: string;
      sessionKey?: string;
      contextKey?: string;
      deliveryContext?: DeliveryContext;
    },
  ) => CronSystemEventEnqueueResult;
  /**
   * Resolve the channel-correct origin delivery context for a session key (the
   * value the channel's send expects, e.g. Telegram message_thread_id), sourced
   * from the session store entry the wake targets. Used to carry the bound
   * thread/topic onto manual wake system events. Optional: when unset, wakes
   * route as before. Returning `undefined` is also a no-op (default routing).
   */
  resolveOriginDeliveryContext?: (params: {
    sessionKey?: string;
    agentId?: string;
  }) => DeliveryContext | undefined;
  requestHeartbeat: (opts: HeartbeatWakeRequest) => void;
  runHeartbeatOnce?: (opts?: {
    source?: HeartbeatWakeRequest["source"];
    intent?: HeartbeatWakeRequest["intent"];
    reason?: string;
    agentId?: string;
    sessionKey?: string;
    /** Optional heartbeat config override (e.g. target: "last" for cron-triggered heartbeats). */
    heartbeat?: HeartbeatWakeRequest["heartbeat"];
  }) => Promise<HeartbeatRunResult>;
  /**
   * WakeMode=now: max time to wait for runHeartbeatOnce to stop returning
   * { status:"skipped", reason:"requests-in-flight" } before falling back to
   * requestHeartbeat.
   */
  wakeNowHeartbeatBusyMaxWaitMs?: number;
  /** WakeMode=now: delay between runHeartbeatOnce retries while busy. */
  wakeNowHeartbeatBusyRetryDelayMs?: number;
  runIsolatedAgentJob: (params: {
    job: CronJob;
    message: string;
    abortSignal?: AbortSignal;
    onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
    onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
    onLaneWait?: (info?: { waiting?: boolean }) => void;
  }) => Promise<
    {
      summary?: string;
      /** Last non-empty agent text output (not truncated). */
      outputText?: string;
      /**
       * `true` when the isolated run already delivered its output to the target
       * channel (including matching messaging-tool sends). See:
       * https://github.com/openclaw/openclaw/issues/15692
       */
      delivered?: boolean;
      /**
       * `true` when announce/direct delivery was attempted for this run, even
       * if the final per-message ack status is uncertain.
       */
      deliveryAttempted?: boolean;
      delivery?: CronDeliveryTrace;
    } & CronRunOutcome &
      CronRunTelemetry
  >;
  runCommandJob?: (params: { job: CronJob; abortSignal?: AbortSignal }) => Promise<
    {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      delivery?: CronDeliveryTrace;
    } & CronRunOutcome
  >;
  cleanupTimedOutAgentRun?: (params: {
    job: CronJob;
    timeoutMs: number;
    execution?: CronAgentExecutionStarted;
  }) => Promise<void>;
  onIsolatedAgentSetupTimeout?: (params: {
    job: CronJob;
    error: string;
    timeoutMs: number;
  }) => void | Promise<void>;
  sendCronFailureAlert?: (params: {
    job: CronJob;
    text: string;
    channel: CronMessageChannel;
    to?: string;
    mode?: "announce" | "webhook";
    accountId?: string;
  }) => Promise<void>;
  onEvent?: (evt: CronEvent) => void;
};

/** Cron deps after optional defaults have been made concrete. */
export type CronServiceDepsInternal = Omit<CronServiceDeps, "nowMs"> & {
  nowMs: () => number;
};

/** Mutable cron service state shared across store, job, timer, and ops helpers. */
export type CronServiceState = {
  deps: CronServiceDepsInternal;
  store: CronStoreFile | null;
  /** Last known durable wake for each persisted job. Map presence distinguishes
   * a durably unscheduled job from one that is not part of durable topology. */
  durableNextRunAtMsByJobId: Map<string, number | undefined>;
  timer: NodeJS.Timeout | null;
  running: boolean;
  stopped: boolean;
  restartRecoveryPending: boolean;
  /** Prevents maintenance reads from advancing deferred startup catch-up slots.
   * Entries are removed when the deferred job runs or becomes irrelevant. */
  pendingCatchupDeferralJobIds: Set<string>;
  activeManualRunJobIds: Set<string>;
  manualSetupTimeoutNotified: boolean;
  /** Serializes mutating service operations so store writes and timers stay ordered. */
  op: Promise<unknown>;
  warnedDisabled: boolean;
  /**
   * Persisted job rows with non-canonical storage shape are skipped in memory
   * until the runtime can quarantine and sanitize the active store.
   */
  warnedInvalidPersistedJobKeys: Set<string>;
  pendingQuarantineConfigJobs: QuarantinedCronConfigJob[];
  lastQuarantineFailureWarnKey: string | null;
  storeLoadedAtMs: number | null;
};

/** Creates mutable cron service state with a concrete clock dependency. */
export function createCronServiceState(deps: CronServiceDeps): CronServiceState {
  return {
    deps: { ...deps, nowMs: deps.nowMs ?? (() => Date.now()) },
    store: null,
    durableNextRunAtMsByJobId: new Map<string, number | undefined>(),
    timer: null,
    running: false,
    stopped: false,
    restartRecoveryPending: false,
    pendingCatchupDeferralJobIds: new Set<string>(),
    activeManualRunJobIds: new Set<string>(),
    manualSetupTimeoutNotified: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    warnedInvalidPersistedJobKeys: new Set<string>(),
    pendingQuarantineConfigJobs: [],
    lastQuarantineFailureWarnKey: null,
    storeLoadedAtMs: null,
  };
}

/** Dispatches a cron event without letting subscriber errors escape scheduler work. */
export function emit(state: CronServiceState, evt: CronEvent) {
  try {
    state.deps.onEvent?.(evt);
  } catch {
    /* ignore */
  }
}

/** Direct-run mode: respect due time or force execution. */
export type CronRunMode = "due" | "force";

/** Main-session wake strategy used after enqueuing cron text. */
export type CronWakeMode = "now" | "next-heartbeat";

/** Lightweight service status returned to gateway/control surfaces. */
export type CronStatusSummary = {
  enabled: boolean;
  /** @deprecated Legacy partition key; actual storage is SQLite. Use `sqlitePath`. */
  storePath: string;
  /** Storage backend identifier. */
  storage: "sqlite";
  /** Resolved path to the shared state SQLite database. */
  sqlitePath: string;
  jobs: number;
  nextWakeAtMs: number | null;
};

/** Result shape for immediate or queued cron run requests. */
export type CronRunResult =
  | { ok: true; ran: true }
  | { ok: true; enqueued: true; runId: string }
  | { ok: true; ran: false; reason: "not-due" }
  | { ok: true; ran: false; reason: "already-running" }
  | { ok: true; ran: false; reason: "restart-recovery-pending" }
  | { ok: true; ran: false; reason: "invalid-spec" }
  | { ok: true; ran: false; reason: "stopped" }
  | { ok: false };

/** Remove result that distinguishes missing jobs from failed removal. */
export type CronRemoveResult = { ok: true; removed: boolean } | { ok: false; removed: false };

/** Created cron job returned by service mutation calls. */
export type CronDeclarativeAddResult = CronJob & {
  created: boolean;
  updated?: boolean;
  job: CronJob;
};
export type CronAddResult = CronJob | CronDeclarativeAddResult;
/** Updated cron job returned by service mutation calls. */
export type CronUpdateResult = CronJob;

/** Chronological job list returned by service read calls. */
export type CronListResult = CronJob[];
/** Normalized create input accepted by the cron service. */
export type CronAddInput = CronJobCreate;
/** Caller-specific declaration-key visibility and explicit enablement metadata. */
export type CronAddOptions = {
  matchesExisting?: (job: CronJob) => boolean;
  enabledExplicit?: boolean;
};
/** Normalized patch input accepted by cron service updates. */
export type CronUpdateInput = CronJobPatch;
/** Cron-store-locked guard evaluated against the current job before an update applies. */
export type CronUpdatePrecondition = (job: CronJob, nowMs: number) => void | Promise<void>;
