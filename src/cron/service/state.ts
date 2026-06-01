import type { CronConfig } from "../../config/types.cron.js";
import type { HeartbeatRunResult, HeartbeatWakeRequest } from "../../infra/heartbeat-wake.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { QuarantinedCronConfigJob } from "../store.js";
import type {
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
  action: "added" | "updated" | "removed" | "started" | "finished";
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
} & CronRunTelemetry;

/** Logger contract consumed by cron service internals. */
export type Logger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/** Dependency injection surface for the cron service runtime. */
export type CronServiceDeps = {
  nowMs?: () => number;
  log: Logger;
  storePath: string;
  cronEnabled: boolean;
  /** CronConfig for session retention settings. */
  cronConfig?: CronConfig;
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
  ) => void;
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
  cleanupTimedOutAgentRun?: (params: {
    job: CronJob;
    timeoutMs: number;
    execution?: CronAgentExecutionStarted;
  }) => Promise<void>;
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
  timer: NodeJS.Timeout | null;
  running: boolean;
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
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    warnedInvalidPersistedJobKeys: new Set<string>(),
    pendingQuarantineConfigJobs: [],
    lastQuarantineFailureWarnKey: null,
    storeLoadedAtMs: null,
  };
}

/** Direct-run mode: respect due time or force execution. */
export type CronRunMode = "due" | "force";

/** Main-session wake strategy used after enqueuing cron text. */
export type CronWakeMode = "now" | "next-heartbeat";

/** Lightweight service status returned to gateway/control surfaces. */
export type CronStatusSummary = {
  enabled: boolean;
  storePath: string;
  jobs: number;
  nextWakeAtMs: number | null;
};

/** Result shape for immediate or queued cron run requests. */
export type CronRunResult =
  | { ok: true; ran: true }
  | { ok: true; enqueued: true; runId: string }
  | { ok: true; ran: false; reason: "not-due" }
  | { ok: true; ran: false; reason: "already-running" }
  | { ok: false };

/** Remove result that distinguishes missing jobs from failed removal. */
export type CronRemoveResult = { ok: true; removed: boolean } | { ok: false; removed: false };

/** Created cron job returned by service mutation calls. */
export type CronAddResult = CronJob;
/** Updated cron job returned by service mutation calls. */
export type CronUpdateResult = CronJob;

/** Chronological job list returned by service read calls. */
export type CronListResult = CronJob[];
/** Normalized create input accepted by the cron service. */
export type CronAddInput = CronJobCreate;
/** Normalized patch input accepted by cron service updates. */
export type CronUpdateInput = CronJobPatch;
