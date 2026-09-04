/** Cron service dependency, event, state, and public result types. */

import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import type { ExecutionIdentityAdmissionFacts } from "../../audit/execution-identity-admission.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { NormalizeReplySkipReason } from "../../auto-reply/reply/normalize-reply-skip-reason.js";
import type { SessionCreatedActor } from "../../config/sessions/session-entry-provenance.js";
import type { CronConfig } from "../../config/types.cron.js";
import type { HeartbeatRunResult, HeartbeatWakeRequest } from "../../infra/heartbeat-wake.js";
import type { CommandLaneTaskMarker } from "../../process/command-queue.js";
import { LEGACY_IMPLICIT_AGENT_ID } from "../../routing/session-key.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import { toPublicCronJob } from "../public-job.js";
import type { CronRuntimeAuthority } from "../runtime-authority.js";
import type { CronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import type { QuarantinedCronConfigJob } from "../store.js";
import type { CronRunReceiptHandle } from "../store/run-receipt-store.js";
import type {
  CronCompletionStatus,
  CronTriggerEvaluationResult,
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronFailureNotificationDelivery,
  CronFailureNotificationDetail,
  CronDeliveryStatus,
  CronDeliveryTrace,
  CronResolvedDeliveryState,
  CronJob,
  CronNextCheckProposal,
  CronJobCreate,
  CronJobPatch,
  CronRunDiagnostics,
  CronMessageChannel,
  CronRunOutcome,
  CronRunStatus,
  CronRunTelemetry,
  CronStoredJob,
  CronStoreFile,
  CronToolsAllowExecTarget,
  CronToolsAllowProvenance,
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
  completionStatus?: CronCompletionStatus;
  error?: string;
  summary?: string;
  diagnostics?: CronRunDiagnostics;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  deliverySuppressionReason?: NormalizeReplySkipReason;
  failureNotificationDelivery?: CronFailureNotificationDelivery;
  delivery?: CronDeliveryTrace;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  nextRunAtMs?: number;
  triggerFired?: boolean;
} & CronRunTelemetry;

/** Transient internal context delivered beside, but never projected into, a CronEvent. */
type CronEventContext = {
  failureNotificationDetail?: CronFailureNotificationDetail;
};

/** Builds event context only when a closed notification fact exists. */
export function cronFailureNotificationEventContext(
  failureNotificationDetail?: CronFailureNotificationDetail,
): CronEventContext | undefined {
  return failureNotificationDetail ? { failureNotificationDetail } : undefined;
}

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

/** Notifications queued by cron mutations until their state is durable. */
export type DeferredCronNotifications = Array<() => void>;

/** Dependency injection surface for the cron service runtime. */
export type CronServiceDeps = {
  nowMs?: () => number;
  log: Logger;
  storePath: string;
  cronEnabled: boolean;
  /** CronConfig for session retention settings. */
  cronConfig?: CronConfig;
  /** List enabled, configured channel ids without exposing channel machinery to cron core. */
  listConfiguredChannels?: () => readonly string[] | Promise<readonly string[]>;
  evaluateCronTrigger?: (params: {
    job: CronStoredJob;
    script: string;
    state: unknown;
    streamBatch?: string;
    abortSignal?: AbortSignal;
  }) => Promise<CronTriggerEvaluationResult>;
  /** Default agent id for jobs without an agent id. */
  defaultAgentId?: string;
  /** Resolve the current default when runtime config can change after startup. */
  resolveDefaultAgentId?: () => string | undefined;
  legacyDefaultAgentId?: string;
  /** Resolve configured or persisted owners whose session stores need periodic cleanup. */
  resolveSessionStoreAgentIds?: () => string[];
  /** Revalidate agent ownership inside the cron mutation lock. */
  isAgentAvailable?: (agentId: string) => boolean;
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
  /** Runs timer and startup work inside the owning Gateway's detached scope. */
  runSchedulerOwned?: <T>(run: () => Promise<T>) => Promise<T>;
  requestHeartbeat: (
    opts: HeartbeatWakeRequest,
    retry?: Extract<HeartbeatRunResult, { status: "skipped" }>,
  ) => void;
  /** Waits for the terminal result of a cron-owned coalesced heartbeat wake. */
  requestHeartbeatAndWait?: (
    opts: HeartbeatWakeRequest,
    lifecycle: { abortSignal?: AbortSignal },
  ) => Promise<HeartbeatRunResult>;
  runHeartbeatOnce?: (opts?: {
    source?: HeartbeatWakeRequest["source"];
    intent?: HeartbeatWakeRequest["intent"];
    reason?: string;
    agentId?: string;
    sessionKey?: string;
    /** Exact cron run marker whose own activity must not block its awaited wake. */
    owningCronJobMarker?: CronActiveJobMarker;
    /** Exact command-lane task whose own slot must not block its awaited wake. */
    owningCronLaneTaskMarker?: CommandLaneTaskMarker;
    /** Optional heartbeat config override (e.g. target: "last" for cron-triggered heartbeats). */
    heartbeat?: HeartbeatWakeRequest["heartbeat"];
  }) => Promise<HeartbeatRunResult>;
  /** Resolves the outer watchdog for an awaited heartbeat handoff. */
  resolveHeartbeatTimeoutMs?: (
    opts: HeartbeatWakeRequest & { agentId: string },
  ) => number | undefined;
  runSkillCollectionReview?: (params: {
    agentId: string;
    abortSignal?: AbortSignal;
  }) => Promise<
    | { status: "ok" | "skipped"; summary: string }
    | { status: "error"; summary: string; error: string }
  >;
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
    executionIdentity?: CronExecutionIdentityAdmission;
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
      deliveryError?: string;
      deliverySuppressionReason?: NormalizeReplySkipReason;
      deliveryState?: CronResolvedDeliveryState;
      /**
       * `true` when announce/direct delivery was attempted for this run, even
       * if the final per-message ack status is uncertain.
       */
      deliveryAttempted?: boolean;
      delivery?: CronDeliveryTrace;
      nextCheck?: CronNextCheckProposal;
    } & CronRunOutcome &
      CronRunTelemetry
  >;
  runCommandJob?: (params: { job: CronJob; abortSignal?: AbortSignal }) => Promise<
    {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      deliveryError?: string;
      deliverySuppressionReason?: NormalizeReplySkipReason;
      deliveryState?: CronResolvedDeliveryState;
      delivery?: CronDeliveryTrace;
    } & CronRunOutcome
  >;
  runScriptJob?: (params: {
    job: CronStoredJob;
    streamBatch?: string;
    abortSignal?: AbortSignal;
  }) => Promise<
    {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      deliveryError?: string;
      deliverySuppressionReason?: NormalizeReplySkipReason;
      deliveryState?: CronResolvedDeliveryState;
      delivery?: CronDeliveryTrace;
      notify?: string;
      wake?: "now" | "next-heartbeat";
      stateChanged?: boolean;
      state?: unknown;
      nextCheck?: CronNextCheckProposal;
    } & CronRunOutcome
  >;
  /** Deliver a primary cron webhook before the run outcome is finalized. */
  sendCronWebhook?: (params: {
    job: CronJob;
    event: CronEvent;
    abortSignal: AbortSignal;
    onDeliveryAccepted: () => void;
  }) => Promise<void>;
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
    payload: ReplyPayload;
    runAtMs?: number;
    channel: CronMessageChannel;
    to?: string;
    mode?: "announce" | "webhook";
    accountId?: string;
    threadId?: string | number;
    inheritSessionThread?: false;
    /** Persists the transport-owned terminal fact before Gateway work admission releases. */
    onDeliverySettled: (outcome: CronFailureNotificationDelivery) => Promise<void>;
  }) => Promise<void>;
  onEvent?: (evt: CronEvent, context?: CronEventContext) => void;
};

export type CronExecutionIdentityAdmission = {
  ingress: ExecutionIdentityAdmissionFacts["ingress"];
  invoker?: ExecutionIdentityAdmissionFacts["invoker"];
  onPostAdmission?: (context: AdmittedRunContext) => void;
  onExecutionStarted?: () => void;
};

/** Cron deps after optional defaults have been made concrete. */
type CronServiceDepsInternal = Omit<CronServiceDeps, "nowMs"> & {
  nowMs: () => number;
};

/** Process-local admission state shared by every execution entry point of one cron service. */
type CronRunAdmission = {
  active: number;
  waiters: Array<(release: (() => void) | null) => void>;
  /** One bounded wake-up for scheduled work left without a free slot. */
  capacityListener: (() => void) | null;
};

type QueuedCronRunReservation = {
  identity: object;
  lifecycleGeneration: number;
  markerAtMs: number;
  runReceipt: CronRunReceiptHandle;
  preserveWhenDisabled: boolean;
  activationPreviousLastError?: { value: string | undefined };
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
  /** Number of timer batches currently executing admitted scheduled work. */
  activeTimerTicks: number;
  stopped: boolean;
  /** Rotates synchronously on stop so an immediate restart cannot revive old work. */
  lifecycleGeneration: number;
  schedulingPaused: boolean;
  schedulerStarted: boolean;
  /** Owns scheduled-tick exclusion until startup catch-up publishes deferred slots. */
  startupCatchup?: object;
  activeManualRunJobIds: Set<string>;
  manualSetupTimeoutNotified: boolean;
  /** Bounds scheduled, manual, and on-exit work with one shared cron limit. */
  runAdmission: CronRunAdmission;
  /** Durable markers for cron runs that are waiting for the shared admission limit. */
  queuedRunReservationsByJobId: Map<string, QueuedCronRunReservation>;
  /** Serializes mutating service operations so store writes and timers stay ordered. */
  op: Promise<unknown>;
  warnedDisabled: boolean;
  /**
   * Persisted job rows with non-canonical storage shape are skipped in memory
   * until the runtime can quarantine and sanitize the active store.
   */
  warnedInvalidPersistedJobKeys: Set<string>;
  /** Availability is rechecked every tick; this set only bounds skip diagnostics. */
  reportedUnavailableReaperAgentIds: Set<string>;
  pendingQuarantineConfigJobs: QuarantinedCronConfigJob[];
  lastQuarantineFailureWarnKey: string | null;
  storeLoadedAtMs: number | null;
};

/** Creates mutable cron service state with a concrete clock dependency. */
export function createCronServiceState(deps: CronServiceDeps): CronServiceState {
  // The public CronService constructor shipped before roster-aware callers.
  // Preserve its implicit owner unless a static or dynamic configured default exists.
  const defaultAgentId =
    deps.defaultAgentId ?? (deps.resolveDefaultAgentId ? undefined : LEGACY_IMPLICIT_AGENT_ID);
  return {
    deps: { ...deps, defaultAgentId, nowMs: deps.nowMs ?? (() => Date.now()) },
    store: null,
    durableNextRunAtMsByJobId: new Map<string, number | undefined>(),
    timer: null,
    running: false,
    activeTimerTicks: 0,
    stopped: false,
    lifecycleGeneration: 0,
    schedulingPaused: false,
    schedulerStarted: false,
    activeManualRunJobIds: new Set<string>(),
    manualSetupTimeoutNotified: false,
    runAdmission: { active: 0, waiters: [], capacityListener: null },
    queuedRunReservationsByJobId: new Map<string, QueuedCronRunReservation>(),
    op: Promise.resolve(),
    warnedDisabled: false,
    warnedInvalidPersistedJobKeys: new Set<string>(),
    reportedUnavailableReaperAgentIds: new Set<string>(),
    pendingQuarantineConfigJobs: [],
    lastQuarantineFailureWarnKey: null,
    storeLoadedAtMs: null,
  };
}

/** Dispatches a cron event without letting subscriber errors escape scheduler work. */
export function emit(state: CronServiceState, evt: CronEvent, context?: CronEventContext) {
  try {
    const publicEvent = evt.job ? { ...evt, job: toPublicCronJob(evt.job) } : evt;
    if (context) {
      state.deps.onEvent?.(publicEvent, context);
    } else {
      state.deps.onEvent?.(publicEvent);
    }
  } catch {
    /* ignore */
  }
}

/** Direct-run mode: respect due time, force execution, or run immediately while enabled. */
export type CronRunMode = "due" | "force" | "if-enabled";

export function isImmediateCronRunMode(mode: CronRunMode | undefined): boolean {
  return mode === "force" || mode === "if-enabled";
}

/** Main-session wake strategy used after enqueuing cron text. */
export type CronWakeMode = "now" | "next-heartbeat";

/** Lightweight service status returned to gateway/control surfaces. */
export type CronStatusSummary = {
  enabled: boolean;
  triggersEnabled: boolean;
  /** @deprecated Alias for `sqlitePath`. */
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
  | { ok: true; ran: false; reason: "disabled" }
  | { ok: true; ran: false; reason: "not-due" }
  | { ok: true; ran: false; reason: "already-running" }
  | { ok: true; ran: false; reason: "invalid-spec" }
  | { ok: true; ran: false; reason: "stopped" }
  | { ok: false };

/** Remove result that distinguishes missing jobs from failed removal. */
export type CronRemoveResult = { ok: true; removed: boolean } | { ok: false; removed: false };

/** Created cron job returned by service mutation calls. */
type CronDeclarativeAddResult = CronStoredJob & {
  created: boolean;
  updated?: boolean;
  job: CronStoredJob;
};
export type CronAddResult = CronStoredJob | CronDeclarativeAddResult;
/** Updated cron job returned by service mutation calls. */
export type CronUpdateResult = CronJob;

/** Chronological job list returned by service read calls. */
export type CronListResult = CronJob[];
/** Normalized create input accepted by the cron service. */
export type CronAddInput = CronJobCreate;
/** Caller-specific declaration-key visibility and explicit enablement metadata. */
export type CronAddOptions = {
  /** Selected revisions captured from a validated caller session, never public input. */
  skillLibrarySelections?: CronStoredJob["skillLibrarySelections"];
  matchesExisting?: (job: CronJob) => boolean;
  enabledExplicit?: boolean;
  /** Gateway/doctor-owned heartbeat jobs require this opt-in at service creation. */
  systemOwned?: boolean;
  /** Trusted creator provenance persisted with new jobs; never accepted from public input. */
  createdActor?: SessionCreatedActor;
  /** Authenticated caller provenance stamped by the service, never public input. */
  scheduledToolPolicy?: CronScheduledToolPolicy;
  /** Private proof from an authenticated agent-runtime caller. */
  toolsAllowProvenance?: CronToolsAllowProvenance;
  /** Restrict-only exec pin from the signed creator-turn identity. */
  toolsAllowExecTarget?: CronToolsAllowExecTarget;
  /** Synchronous Gateway-owned liveness guard consumed immediately before mutation. */
  commitGuard?: () => void;
  /** One-use fresh capture; callback presence means fresh even when it returns undefined. */
  captureRuntimeAuthority?: () => CronRuntimeAuthority | undefined;
};
/** Normalized patch input accepted by cron service updates. */
export type CronUpdateInput = CronJobPatch;
/** Authenticated caller provenance used only when a tool policy is explicitly adopted. */
export type CronUpdateOptions = {
  scheduledToolPolicy?: CronScheduledToolPolicy;
  toolsAllowProvenance?: CronToolsAllowProvenance;
  /** Restrict-only exec pin from the signed creator-turn identity. */
  toolsAllowExecTarget?: CronToolsAllowExecTarget;
  /** Synchronous Gateway-owned liveness guard consumed immediately before mutation. */
  commitGuard?: () => void;
  /** One-use fresh capture; callback presence means fresh even when it returns undefined. */
  captureRuntimeAuthority?: () => CronRuntimeAuthority | undefined;
};

export type CronCommitGuardOptions = {
  /** Synchronous Gateway-owned guard consumed at the mutation owner. */
  commitGuard?: () => void;
};
/** Cron-store-locked guard evaluated against the current job before an update applies. */
export type CronUpdatePrecondition = (job: CronJob, nowMs: number) => void | Promise<void>;
