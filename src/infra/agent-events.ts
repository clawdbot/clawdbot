// Stores and broadcasts agent lifecycle and streaming events.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { VerboseLevel } from "../auto-reply/thinking.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { createAbortError } from "./abort-signal.js";
import { hasInvalidLifecycleStartTimestamp } from "./agent-event-lifecycle.js";
import { clearAgentRunUsage, resetAgentRunUsageForTest } from "./agent-run-usage.js";

/** Approval event phase for request/resolution transitions. */
type AgentApprovalEventPhase = "requested" | "resolved";
/** Approval status after routing, user action, or delivery failure. */
type AgentApprovalEventStatus = "pending" | "unavailable" | "approved" | "denied" | "failed";
/** Approval family used by renderers and host hooks. */
type AgentApprovalEventKind = "exec" | "plugin" | "unknown";

/** Payload for approval requests and their later resolution events. */
export type AgentApprovalEventData = {
  phase: AgentApprovalEventPhase;
  kind: AgentApprovalEventKind;
  status: AgentApprovalEventStatus;
  title: string;
  itemId?: string;
  toolCallId?: string;
  approvalId?: string;
  approvalSlug?: string;
  command?: string;
  host?: string;
  reason?: string;
  scope?: "turn" | "session";
  message?: string;
};

/** Stream name for agent events delivered to gateway listeners and plugin host hooks. */
export type AgentEventStream =
  | "lifecycle"
  | "tool"
  | "assistant"
  | "usage"
  | "error"
  | "item"
  | "plan"
  | "approval"
  | "command_output"
  | "patch"
  | "compaction"
  | "thinking"
  | (string & {});

/** Enriched event delivered to subscribers after sequencing and context stamping. */
export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  /** Internal, non-enumerable gateway lifecycle generation that owns this run. */
  lifecycleGeneration?: string;
  sessionKey?: string;
  /**
   * sessionId the run was bound to when it started. Lifecycle persistence uses
   * this to reject terminal events from a pre-`sessions.reset` run that would
   * otherwise clobber the rotated session row resolved by the shared sessionKey.
   */
  sessionId?: string;
  agentId?: string;
};

/** Gateway-only routing metadata stamped onto events after public input validation. */
export type AgentEventRuntimePayload = AgentEventPayload & {
  readonly controlUiVisible?: boolean;
  readonly contextClaimId?: string;
  readonly deliverySessionKey?: string;
};

/** Per-run metadata used to stamp events and gate Control UI visibility. */
type AgentRunContext = {
  sessionKey?: string;
  /** Resolved agent owner, including for unscoped session keys. */
  agentId?: string;
  /** Owning run's sessionId; stamped onto lifecycle events (see AgentEventPayload.sessionId). */
  sessionId?: string;
  /** Gateway lifecycle generation captured when the run was registered. */
  lifecycleGeneration?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  /** Whether control UI clients should receive chat/agent updates for this run. */
  isControlUiVisible?: boolean;
  projectSessionActive?: boolean;
  /** Active cadence state by job; admission permits one invocation per job. */
  cronRunsByJobId?: Map<string, { pacingEnabled: boolean; nextCheckMs?: number }>;
  /** Timestamp when this context was first registered (for TTL-based cleanup). */
  registeredAt?: number;
  /** Timestamp of last activity (updated on every emitAgentEvent). */
  lastActiveAt?: number;
};

type AgentEventState = {
  seqByRun: Map<string, number>;
  listeners: Set<(evt: AgentEventRuntimePayload) => void>;
  auditListeners: Set<(evt: AgentEventPayload) => void>;
  runContextById: Map<string, AgentRunContext>;
  runContextOwnersById?: Map<
    string,
    {
      lifecycleGeneration: string;
      claimIds: Set<string>;
      preserveAfterRelease: boolean;
      clearRequested: boolean;
      exclusiveClaimId?: string;
      clearListeners?: Map<string, (claimId: string) => void>;
    }
  >;
  lifecycleGeneration: string;
  lifecycleRotationHandlers?: Map<string, (lifecycleGeneration: string) => void>;
};

const AGENT_EVENT_STATE_KEY = Symbol.for("openclaw.agentEvents.state");
const AGENT_EVENT_EXECUTION_CONTEXT_KEY = Symbol.for("openclaw.agentEvents.executionContext");

type AgentEventExecutionContext = {
  lifecycleGeneration: string;
  onceByRun: Map<string, Promise<unknown>>;
};

function getAgentEventState(): AgentEventState {
  return resolveGlobalSingleton<AgentEventState>(AGENT_EVENT_STATE_KEY, () => ({
    seqByRun: new Map<string, number>(),
    listeners: new Set<(evt: AgentEventRuntimePayload) => void>(),
    auditListeners: new Set<(evt: AgentEventPayload) => void>(),
    runContextById: new Map<string, AgentRunContext>(),
    lifecycleGeneration: randomUUID(),
  }));
}

function getAgentEventExecutionContext() {
  return resolveGlobalSingleton<AsyncLocalStorage<AgentEventExecutionContext>>(
    AGENT_EVENT_EXECUTION_CONTEXT_KEY,
    () => new AsyncLocalStorage<AgentEventExecutionContext>(),
  );
}

/** Runs one execution with immutable ownership inherited by every emitted stream event. */
export function withAgentRunLifecycleGeneration<T>(lifecycleGeneration: string, run: () => T): T {
  const storage = getAgentEventExecutionContext();
  const parent = storage.getStore();
  const onceByRun =
    parent?.lifecycleGeneration === lifecycleGeneration ? parent.onceByRun : new Map();
  return storage.run({ lifecycleGeneration, onceByRun }, run);
}

/** Shares one operation across fallback attempts that belong to the same admitted run. */
export function runOncePerAgentRun<T>(runId: string, operation: string, run: () => Promise<T>) {
  const context = getAgentEventExecutionContext().getStore();
  if (!context) {
    return run();
  }
  const key = `${operation}:${runId}`;
  const existing = context.onceByRun.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  const pending = Promise.resolve().then(run);
  context.onceByRun.set(key, pending);
  return pending;
}

export function getAgentEventLifecycleGeneration(): string {
  return getAgentEventState().lifecycleGeneration;
}

export function isAgentEventLifecycleGenerationCurrent(lifecycleGeneration: string): boolean {
  return lifecycleGeneration === getAgentEventState().lifecycleGeneration;
}

/** Registers process-local state cleanup at the gateway lifecycle boundary. */
export function registerAgentEventLifecycleRotationHandler(
  key: string,
  handler: (lifecycleGeneration: string) => void,
): void {
  const state = getAgentEventState();
  const handlers =
    state.lifecycleRotationHandlers ??
    (state.lifecycleRotationHandlers = new Map<string, (lifecycleGeneration: string) => void>());
  handlers.set(key, handler);
}

/** Rejects work that no longer belongs to the active gateway lifecycle. */
export function assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration: string): void {
  if (isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
    return;
  }
  throw createAbortError("Agent run belongs to a stale gateway lifecycle");
}

/** Captures immutable lifecycle ownership for one admitted execution. */
export function captureAgentRunLifecycleGeneration(runId: string): string {
  return (
    getAgentEventExecutionContext().getStore()?.lifecycleGeneration ??
    getAgentEventState().runContextById.get(runId)?.lifecycleGeneration ??
    getAgentEventState().lifecycleGeneration
  );
}

/** Starts a new ownership generation before an in-process gateway restart. */
export function rotateAgentEventLifecycleGeneration(): string {
  const state = getAgentEventState();
  state.lifecycleGeneration = randomUUID();
  // Rotation is the liveness choke point: after it returns, no prior-generation
  // owner is operationally reachable. Recovery and runtime consumers therefore
  // agree that only current-generation owners can drive or receive work.
  const errors: unknown[] = [];
  notifyListeners(
    state.lifecycleRotationHandlers?.values() ?? [],
    state.lifecycleGeneration,
    (error) => errors.push(error),
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to retire stale agent lifecycle owners");
  }
  return state.lifecycleGeneration;
}

/** Registers or merges per-run context used by later agent event emissions. */
export function registerAgentRunContext(runId: string, context: AgentRunContext, claimId?: string) {
  if (!runId) {
    return;
  }
  const state = getAgentEventState();
  const lifecycleGeneration = context.lifecycleGeneration ?? state.lifecycleGeneration;
  const owners = getAgentRunContextOwners(state).get(runId);
  if (
    owners?.lifecycleGeneration === lifecycleGeneration &&
    owners.exclusiveClaimId &&
    (owners.exclusiveClaimId !== claimId || owners.clearRequested)
  ) {
    return;
  }
  const existing = state.runContextById.get(runId);
  if (!existing) {
    state.runContextById.set(runId, {
      ...context,
      lifecycleGeneration: context.lifecycleGeneration ?? state.lifecycleGeneration,
      registeredAt: context.registeredAt ?? Date.now(),
    });
    return;
  }
  if (
    context.lifecycleGeneration &&
    existing.lifecycleGeneration &&
    context.lifecycleGeneration !== existing.lifecycleGeneration
  ) {
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.sessionId && existing.sessionId !== context.sessionId) {
    existing.sessionId = context.sessionId;
  }
  if (context.agentId && existing.agentId !== context.agentId) {
    existing.agentId = context.agentId;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isControlUiVisible !== undefined) {
    existing.isControlUiVisible = context.isControlUiVisible;
  }
  if (context.projectSessionActive !== undefined) {
    existing.projectSessionActive = context.projectSessionActive;
  }
  if (context.cronRunsByJobId !== undefined) {
    existing.cronRunsByJobId ??= new Map();
    for (const [jobId, cronRun] of context.cronRunsByJobId) {
      existing.cronRunsByJobId.set(jobId, cronRun);
    }
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
  if (context.registeredAt !== undefined) {
    existing.registeredAt = context.registeredAt;
  }
  if (context.lastActiveAt !== undefined) {
    existing.lastActiveAt = context.lastActiveAt;
  }
}

function getAgentRunContextOwners(state = getAgentEventState()) {
  state.runContextOwnersById ??= new Map();
  return state.runContextOwnersById;
}

/** Claims a run id for a newly admitted execution, replacing stale ownership. */
export function claimAgentRunContext(
  runId: string,
  context: AgentRunContext,
  options: {
    /** Adopt a same-generation context only when no tracked execution owns it. */
    adoptExistingUnowned?: boolean;
    trackOwner?: boolean;
    ownsContext?: boolean;
    exclusive?: boolean;
    onClearRequested?: (claimId: string) => void;
  } = {},
): string | undefined {
  if (!runId) {
    return undefined;
  }
  const state = getAgentEventState();
  const lifecycleGeneration = context.lifecycleGeneration ?? state.lifecycleGeneration;
  const existing = state.runContextById.get(runId);
  const ownersById = getAgentRunContextOwners(state);
  const existingOwners = ownersById.get(runId);
  const currentOwners =
    existingOwners?.lifecycleGeneration === lifecycleGeneration ? existingOwners : undefined;
  const adoptsExistingUnowned =
    options.exclusive === true &&
    options.adoptExistingUnowned === true &&
    existing?.lifecycleGeneration === lifecycleGeneration &&
    currentOwners === undefined;
  if (
    currentOwners?.exclusiveClaimId ||
    (options.exclusive &&
      ((existing?.lifecycleGeneration === lifecycleGeneration && !adoptsExistingUnowned) ||
        currentOwners !== undefined))
  ) {
    return undefined;
  }
  let claimId: string | undefined;
  if (options.trackOwner) {
    claimId = randomUUID();
    if (currentOwners) {
      currentOwners.claimIds.add(claimId);
      if (options.ownsContext) {
        currentOwners.preserveAfterRelease = false;
      }
      if (options.onClearRequested) {
        currentOwners.clearListeners ??= new Map();
        currentOwners.clearListeners.set(claimId, options.onClearRequested);
      }
    } else {
      ownersById.set(runId, {
        lifecycleGeneration,
        claimIds: new Set([claimId]),
        preserveAfterRelease:
          options.ownsContext !== true && existing?.lifecycleGeneration === lifecycleGeneration,
        clearRequested: false,
        ...(options.exclusive ? { exclusiveClaimId: claimId } : {}),
        ...(options.onClearRequested
          ? { clearListeners: new Map([[claimId, options.onClearRequested]]) }
          : {}),
      });
    }
  } else if (existingOwners?.lifecycleGeneration !== lifecycleGeneration) {
    // Same-generation untracked claims refresh metadata inside the tracked
    // execution. A new lifecycle replaces that ownership outright.
    ownersById.delete(runId);
  }
  if (existing?.lifecycleGeneration === lifecycleGeneration) {
    registerAgentRunContext(
      runId,
      {
        ...context,
        lifecycleGeneration,
      },
      claimId,
    );
    return claimId;
  }
  state.runContextById.set(runId, {
    ...context,
    lifecycleGeneration,
    registeredAt: context.registeredAt ?? Date.now(),
  });
  state.seqByRun.delete(runId);
  clearAgentRunUsage(runId);
  return claimId;
}

/** Returns the currently registered context for a run, if it has not been cleared or swept. */
export function getAgentRunContext(runId: string) {
  return getAgentEventState().runContextById.get(runId);
}

/** Records the latest next-check proposal on the matching paced cron run. */
export function recordCronNextCheckProposal(runId: string, jobId: string, delayMs: number): void {
  const context = getAgentEventState().runContextById.get(runId);
  const cronRun = context?.cronRunsByJobId?.get(jobId);
  if (!cronRun) {
    throw new Error("cron next_check is only available to the currently running job");
  }
  if (!cronRun.pacingEnabled) {
    throw new Error("cron next_check requires pacing on the current job");
  }
  cronRun.nextCheckMs = delayMs;
}

/** Consumes one successful cron run's proposal so it cannot affect a later run. */
export function consumeCronNextCheckProposal(runId: string, jobId: string): number | undefined {
  const context = getAgentEventState().runContextById.get(runId);
  const cronRuns = context?.cronRunsByJobId;
  const cronRun = cronRuns?.get(jobId);
  if (!cronRun) {
    return undefined;
  }
  cronRuns?.delete(jobId);
  if (cronRuns?.size === 0 && context) {
    delete context.cronRunsByJobId;
  }
  return cronRun.nextCheckMs;
}

export function getAgentRunContextOwnerStatus(
  runId: string,
  claimId: string,
  lifecycleGeneration: string,
): "active" | "clear-requested" | undefined {
  const state = getAgentEventState();
  const owners = getAgentRunContextOwners(state).get(runId);
  if (
    lifecycleGeneration !== state.lifecycleGeneration ||
    owners?.lifecycleGeneration !== lifecycleGeneration ||
    !owners.claimIds.has(claimId)
  ) {
    return undefined;
  }
  return owners.clearRequested ? "clear-requested" : "active";
}

/** Lists active runs bound to one current session identity. */
export function listAgentRunsForSession(params: {
  sessionKey: string;
  sessionId?: string;
}): Array<{ runId: string; lifecycleGeneration: string }> {
  const currentLifecycleGeneration = getAgentEventState().lifecycleGeneration;
  const runs: Array<{ runId: string; lifecycleGeneration: string }> = [];
  for (const [runId, context] of getAgentEventState().runContextById) {
    const matches = context.sessionId
      ? context.sessionId === params.sessionId
      : context.sessionKey === params.sessionKey;
    if (matches && context.lifecycleGeneration === currentLifecycleGeneration) {
      runs.push({ runId, lifecycleGeneration: context.lifecycleGeneration });
    }
  }
  return runs.toSorted((a, b) =>
    a.runId === b.runId
      ? a.lifecycleGeneration.localeCompare(b.lifecycleGeneration)
      : a.runId.localeCompare(b.runId),
  );
}

export function hasProjectedAgentRunForSession(params: {
  sessionKeys: readonly string[];
  sessionId?: string;
}): boolean {
  const lifecycleGeneration = getAgentEventState().lifecycleGeneration;
  for (const context of getAgentEventState().runContextById.values()) {
    const matches =
      (context.sessionKey !== undefined && params.sessionKeys.includes(context.sessionKey)) ||
      (params.sessionId !== undefined && context.sessionId === params.sessionId);
    if (
      matches &&
      context.projectSessionActive === true &&
      context.lifecycleGeneration === lifecycleGeneration
    ) {
      return true;
    }
  }
  return false;
}

/** Clears context and sequence state for a run that has ended or been discarded. */
export function clearAgentRunContext(
  runId: string,
  lifecycleGeneration?: string,
  claimId?: string,
) {
  const state = getAgentEventState();
  const existing = state.runContextById.get(runId);
  if (lifecycleGeneration && existing && existing.lifecycleGeneration !== lifecycleGeneration) {
    return;
  }
  const owners = getAgentRunContextOwners(state).get(runId);
  if (
    claimId &&
    (!owners ||
      (lifecycleGeneration && owners.lifecycleGeneration !== lifecycleGeneration) ||
      !owners.claimIds.has(claimId))
  ) {
    return;
  }
  // A rejected claimant's cleanup must not evict the exclusive owner.
  if (owners?.exclusiveClaimId && owners.exclusiveClaimId !== claimId) {
    return;
  }
  if (owners?.claimIds.size) {
    if (!lifecycleGeneration || owners.lifecycleGeneration === lifecycleGeneration) {
      owners.clearRequested = true;
      for (const [ownerClaimId, listener] of owners.clearListeners ?? []) {
        listener(ownerClaimId);
      }
    }
    return;
  }
  state.runContextById.delete(runId);
  state.seqByRun.delete(runId);
  clearAgentRunUsage(runId, lifecycleGeneration ?? existing?.lifecycleGeneration);
}

/** Releases one tracked owner and clears its context after the final owner exits. */
export function releaseAgentRunContext(runId: string, claimId: string | undefined) {
  if (!runId || !claimId) {
    return;
  }
  const state = getAgentEventState();
  const ownersById = getAgentRunContextOwners(state);
  const owners = ownersById.get(runId);
  if (!owners?.claimIds.delete(claimId)) {
    return;
  }
  owners.clearListeners?.delete(claimId);
  if (owners.exclusiveClaimId === claimId) {
    owners.exclusiveClaimId = undefined;
  }
  if (owners.claimIds.size > 0) {
    return;
  }
  ownersById.delete(runId);
  if (owners.clearRequested || !owners.preserveAfterRelease) {
    clearAgentRunContext(runId, owners.lifecycleGeneration);
  }
}

/**
 * Sweep stale run contexts that exceeded the given TTL.
 * Guards against orphaned entries when lifecycle "end"/"error" events are missed.
 */
export function sweepStaleRunContexts(maxAgeMs = 30 * 60 * 1000): number {
  const state = getAgentEventState();
  const now = Date.now();
  let swept = 0;
  for (const [runId, ctx] of state.runContextById.entries()) {
    // Use lastActiveAt (refreshed on every event) to avoid sweeping active runs.
    // Fall back to registeredAt, then treat missing timestamps as infinitely old.
    const lastSeen = ctx.lastActiveAt ?? ctx.registeredAt;
    const age = lastSeen ? now - lastSeen : Infinity;
    if (age > maxAgeMs) {
      state.runContextById.delete(runId);
      state.seqByRun.delete(runId);
      clearAgentRunUsage(runId, ctx.lifecycleGeneration);
      getAgentRunContextOwners(state).delete(runId);
      swept++;
    }
  }
  return swept;
}

function enrichAgentEvent(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  claimId?: string,
): AgentEventRuntimePayload | undefined {
  const state = getAgentEventState();
  const owners = getAgentRunContextOwners(state).get(event.runId);
  if (claimId !== undefined) {
    if (
      owners?.lifecycleGeneration !== state.lifecycleGeneration ||
      owners.exclusiveClaimId !== claimId ||
      !owners.claimIds.has(claimId) ||
      owners.clearRequested
    ) {
      return undefined;
    }
  } else if (owners?.lifecycleGeneration === state.lifecycleGeneration && owners.exclusiveClaimId) {
    return undefined;
  }
  const context = state.runContextById.get(event.runId);
  const executionLifecycleGeneration =
    event.lifecycleGeneration ?? getAgentEventExecutionContext().getStore()?.lifecycleGeneration;
  const ownedLifecycleGeneration = executionLifecycleGeneration ?? context?.lifecycleGeneration;
  if (
    executionLifecycleGeneration &&
    context?.lifecycleGeneration &&
    executionLifecycleGeneration !== context.lifecycleGeneration
  ) {
    return undefined;
  }
  if (ownedLifecycleGeneration && ownedLifecycleGeneration !== state.lifecycleGeneration) {
    return undefined;
  }
  if (hasInvalidLifecycleStartTimestamp(event.stream, event.data)) {
    return undefined;
  }
  const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
  state.seqByRun.set(event.runId, nextSeq);
  if (context) {
    context.lastActiveAt = Date.now();
  }
  const isControlUiVisible = context?.isControlUiVisible ?? true;
  const eventSessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
  const deliverySessionKey = eventSessionKey ?? context?.sessionKey;
  // Hidden channel-routed runs should not leak live assistant/tool traffic into
  // Control UI, but lifecycle events still need the session key so gateway
  // listeners can persist terminal session state even if run-context lookup is
  // unavailable by the time the terminal event arrives. Terminal failures are
  // emitted on the lifecycle stream with `phase: "error"`; the separate error
  // stream remains redacted for hidden runs because it is observational only.
  const preserveSessionKey = isControlUiVisible || event.stream === "lifecycle";
  const sessionKey = preserveSessionKey ? (eventSessionKey ?? context?.sessionKey) : undefined;
  // Stamp lifecycle events with the owning sessionId (see AgentEventPayload) at
  // emit time, since the run context can be cleared before the terminal persists.
  const sessionId =
    event.stream === "lifecycle" ? (event.sessionId ?? context?.sessionId) : event.sessionId;
  const lifecycleGeneration =
    event.stream === "lifecycle"
      ? (ownedLifecycleGeneration ?? state.lifecycleGeneration)
      : ownedLifecycleGeneration;
  const agentId = event.agentId ?? context?.agentId;
  const enriched: AgentEventRuntimePayload = {
    ...event,
    sessionKey,
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
    seq: nextSeq,
    ts: Date.now(),
  };
  if (lifecycleGeneration) {
    // Persistence needs restart ownership, but agent events are also spread into
    // public payloads. Keep the internal generation readable without serializing it.
    Object.defineProperty(enriched, "lifecycleGeneration", {
      value: lifecycleGeneration,
      enumerable: false,
    });
  }
  if (context?.isControlUiVisible !== undefined) {
    Object.defineProperty(enriched, "controlUiVisible", {
      value: context.isControlUiVisible,
      enumerable: false,
    });
  }
  if (claimId !== undefined) {
    Object.defineProperty(enriched, "contextClaimId", {
      value: claimId,
      enumerable: false,
    });
    if (deliverySessionKey) {
      Object.defineProperty(enriched, "deliverySessionKey", {
        value: deliverySessionKey,
        enumerable: false,
      });
    }
  }
  return enriched;
}

/** Emits an event only when its run ownership is still current. */
export function emitAgentEventIfCurrent(event: Omit<AgentEventPayload, "seq" | "ts">): boolean {
  const enriched = enrichAgentEvent(event);
  if (!enriched) {
    return false;
  }
  notifyListeners(getAgentEventState().listeners, enriched);
  return true;
}

/** Emits an agent event after assigning per-run sequence, timestamp, and context metadata. */
export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  emitAgentEventIfCurrent(event);
}

export function emitAgentEventForOwner(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  claimId: string,
) {
  const enriched = enrichAgentEvent(event, claimId);
  if (enriched) {
    notifyListeners(getAgentEventState().listeners, enriched);
  }
}

/** Emits run metadata only to the Gateway-owned durable audit projection. */
export function emitAgentAuditEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const state = getAgentEventState();
  const enriched = enrichAgentEvent(event);
  if (enriched) {
    notifyListeners(state.auditListeners, enriched);
    const phase = event.stream === "lifecycle" ? event.data.phase : undefined;
    if ((phase === "end" || phase === "error") && !state.runContextById.has(event.runId)) {
      // Private synthetic runs bypass public terminal cleanup. Release sequence state only
      // after synchronous audit listeners consume the terminal event and its final ordering.
      state.seqByRun.delete(event.runId);
    }
  }
}

/** Subscribes to sequenced agent events; returns an unsubscribe callback. */
export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  const state = getAgentEventState();
  return registerListener(state.listeners, listener);
}

/** Subscribes Gateway internals that consume non-public ownership and routing metadata. */
export function onAgentRuntimeEvent(listener: (evt: AgentEventRuntimePayload) => void) {
  return registerListener(getAgentEventState().listeners, listener);
}

/** Subscribes to private audit-only agent events; returns an unsubscribe callback. */
export function onAgentAuditEvent(listener: (evt: AgentEventPayload) => void) {
  return registerListener(getAgentEventState().auditListeners, listener);
}

/** Clears agent event state; test suites with a live Gateway can preserve its listeners. */
export function resetAgentEventsForTest(options?: { preserveListeners?: boolean }) {
  const state = getAgentEventState();
  state.seqByRun.clear();
  resetAgentRunUsageForTest();
  if (!options?.preserveListeners) {
    state.listeners.clear();
    state.auditListeners.clear();
  }
  state.runContextById.clear();
  getAgentRunContextOwners(state).clear();
}
