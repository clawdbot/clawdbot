// Owns process-local agent run context, ownership, and projection state.
import { randomUUID } from "node:crypto";
import type { AgentExecutionAttribution } from "../agents/agent-execution-attribution.js";
import type { VerboseLevel } from "../auto-reply/thinking.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { clearAgentRunUsage, resetAgentRunUsageForTest } from "./agent-run-usage.js";

/** Per-run metadata used to stamp events and gate Control UI visibility. */
type AgentRunContext = {
  /** Immutable admission-owned correlation; later context merges cannot replace it. */
  readonly attribution?: AgentExecutionAttribution;
  sessionKey?: string;
  /** Resolved agent owner, including for unscoped session keys. */
  agentId?: string;
  /** Owning run's sessionId; stamped onto lifecycle events. */
  sessionId?: string;
  /** Gateway lifecycle generation captured when the run was registered. */
  lifecycleGeneration?: string;
  /** Producer-owned start captured from this run's accepted lifecycle event. */
  lifecycleStartedAt?: number;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  /** Whether control UI clients should receive chat/agent updates for this run. */
  isControlUiVisible?: boolean;
  projectSessionActive?: boolean;
  /** Whether lifecycle events may update the shared session row. */
  projectSessionLifecycle?: boolean;
  /** Active cadence state by job; admission permits one invocation per job. */
  cronRunsByJobId?: Map<string, { pacingEnabled: boolean; nextCheckMs?: number }>;
  /** Timestamp when this context was first registered (for TTL-based cleanup). */
  registeredAt?: number;
  /** Timestamp of last activity (updated on every emitAgentEvent). */
  lastActiveAt?: number;
};

type AgentRunContextOwnership = {
  lifecycleGeneration: string;
  claimIds: Set<string>;
  preserveAfterRelease: boolean;
  clearRequested: boolean;
  exclusiveClaimId?: string;
  clearListeners?: Map<string, (claimId: string) => void>;
};

type AgentRunRegistryState = {
  contexts: Map<string, AgentRunContext>;
  owners: Map<string, AgentRunContextOwnership>;
  queuedRunContextLeases?: WeakMap<AgentRunContext, number>;
  lifecycleGeneration: string;
  sequenceResetHandler?: (runId: string) => void;
  version: number;
};

const AGENT_RUN_REGISTRY_STATE_KEY = Symbol.for("openclaw.agentRunRegistry.state");

export class AgentRunAttributionCollisionError extends TypeError {}

function getAgentRunRegistryState(): AgentRunRegistryState {
  return resolveGlobalSingleton<AgentRunRegistryState>(AGENT_RUN_REGISTRY_STATE_KEY, () => ({
    contexts: new Map<string, AgentRunContext>(),
    owners: new Map<string, AgentRunContextOwnership>(),
    lifecycleGeneration: randomUUID(),
    version: 0,
  }));
}

function bumpAgentRunIndexVersion(): void {
  getAgentRunRegistryState().version += 1;
}

function attachAgentExecutionAttribution(
  context: AgentRunContext,
  attribution: AgentExecutionAttribution | undefined,
): void {
  if (!attribution || context.attribution) {
    return;
  }
  Object.defineProperty(context, "attribution", {
    value: attribution,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

/** Rejects a same-generation run id that is already bound to different private identity. */
export function assertAgentRunAttributionCompatible(
  existingAttribution: AgentExecutionAttribution | undefined,
  attribution: AgentExecutionAttribution | undefined,
): void {
  if (existingAttribution && !attribution) {
    throw new AgentRunAttributionCollisionError(
      "Agent run ID is already bound to host-owned execution attribution.",
    );
  }
  if (
    existingAttribution &&
    attribution &&
    (existingAttribution.contextId !== attribution.contextId ||
      existingAttribution.executionId !== attribution.executionId ||
      existingAttribution.createdAt !== attribution.createdAt)
  ) {
    throw new AgentRunAttributionCollisionError(
      "Agent run ID is already bound to different execution attribution.",
    );
  }
}

/**
 * Atomically reserves current-generation attribution before admission audit capture.
 * The first admission owns the immutable value; later conflicting callers fail closed.
 */
export function reserveAgentRunAttribution(
  runId: string,
  lifecycleGeneration: string,
  attribution: AgentExecutionAttribution,
): AgentExecutionAttribution {
  if (attribution.runId !== runId) {
    throw new TypeError("Agent run attribution runId does not match the reserved runId.");
  }
  if (attribution.lifecycleGeneration !== lifecycleGeneration) {
    throw new TypeError(
      "Agent run attribution lifecycleGeneration does not match the reserved generation.",
    );
  }
  const state = getAgentRunRegistryState();
  const existing = state.contexts.get(runId);
  if (existing?.lifecycleGeneration === lifecycleGeneration) {
    assertAgentRunAttributionCompatible(existing.attribution, attribution);
    attachAgentExecutionAttribution(existing, attribution);
    return existing.attribution ?? attribution;
  }
  // Stale callers fail the normal lifecycle guard without replacing a current run.
  if (lifecycleGeneration !== state.lifecycleGeneration) {
    return attribution;
  }
  state.owners.delete(runId);
  state.contexts.set(
    runId,
    createAgentRunContext(
      {
        attribution,
        sessionKey: attribution.sessionKey,
        sessionId: attribution.sessionId,
        agentId: attribution.agentId,
      },
      lifecycleGeneration,
    ),
  );
  state.sequenceResetHandler?.(runId);
  clearAgentRunUsage(runId);
  bumpAgentRunIndexVersion();
  return attribution;
}

function createAgentRunContext(
  context: AgentRunContext,
  lifecycleGeneration: string,
): AgentRunContext {
  const { attribution, ...fields } = context;
  const stored: AgentRunContext = {
    ...fields,
    lifecycleGeneration,
    registeredAt: context.registeredAt ?? Date.now(),
  };
  attachAgentExecutionAttribution(stored, attribution);
  return stored;
}

/** Reads the process-local version of the active-run projection inputs. */
export function readAgentRunIndexVersion(): number {
  return getAgentRunRegistryState().version;
}

export function getAgentRunLifecycleGeneration(): string {
  return getAgentRunRegistryState().lifecycleGeneration;
}

export function rotateAgentRunRegistryLifecycleGeneration(): string {
  const state = getAgentRunRegistryState();
  state.lifecycleGeneration = randomUUID();
  bumpAgentRunIndexVersion();
  return state.lifecycleGeneration;
}

/** Connects registry cleanup to the event sequencer without reversing ownership. */
export function registerAgentRunSequenceResetHandler(handler: (runId: string) => void): void {
  getAgentRunRegistryState().sequenceResetHandler = handler;
}

/** Registers or merges per-run context used by later agent event emissions. */
export function registerAgentRunContext(
  runId: string,
  context: AgentRunContext,
  claimId?: string,
): void {
  if (!runId) {
    return;
  }
  const state = getAgentRunRegistryState();
  const lifecycleGeneration = context.lifecycleGeneration ?? state.lifecycleGeneration;
  const owners = state.owners.get(runId);
  if (
    owners?.lifecycleGeneration === lifecycleGeneration &&
    owners.exclusiveClaimId &&
    (owners.exclusiveClaimId !== claimId || owners.clearRequested)
  ) {
    return;
  }
  const existing = state.contexts.get(runId);
  if (!existing) {
    state.contexts.set(runId, createAgentRunContext(context, lifecycleGeneration));
    bumpAgentRunIndexVersion();
    return;
  }
  if (
    context.lifecycleGeneration &&
    existing.lifecycleGeneration &&
    context.lifecycleGeneration !== existing.lifecycleGeneration
  ) {
    return;
  }
  attachAgentExecutionAttribution(existing, context.attribution);
  let runIndexChanged = false;
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
    runIndexChanged = true;
  }
  if (context.sessionId && existing.sessionId !== context.sessionId) {
    existing.sessionId = context.sessionId;
    runIndexChanged = true;
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
  if (
    context.projectSessionActive !== undefined &&
    existing.projectSessionActive !== context.projectSessionActive
  ) {
    existing.projectSessionActive = context.projectSessionActive;
    runIndexChanged = true;
  }
  if (context.projectSessionLifecycle !== undefined) {
    existing.projectSessionLifecycle = context.projectSessionLifecycle;
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
  if (runIndexChanged) {
    bumpAgentRunIndexVersion();
  }
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
  const state = getAgentRunRegistryState();
  const lifecycleGeneration = context.lifecycleGeneration ?? state.lifecycleGeneration;
  const existing = state.contexts.get(runId);
  const existingOwners = state.owners.get(runId);
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
      state.owners.set(runId, {
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
    state.owners.delete(runId);
  }
  if (existing?.lifecycleGeneration === lifecycleGeneration) {
    const versionBeforeRegister = readAgentRunIndexVersion();
    registerAgentRunContext(runId, { ...context, lifecycleGeneration }, claimId);
    if (readAgentRunIndexVersion() === versionBeforeRegister) {
      bumpAgentRunIndexVersion();
    }
    return claimId;
  }
  state.contexts.set(runId, createAgentRunContext(context, lifecycleGeneration));
  state.sequenceResetHandler?.(runId);
  clearAgentRunUsage(runId);
  bumpAgentRunIndexVersion();
  return claimId;
}

/** Returns the currently registered context for a run, if it has not been cleared or swept. */
export function getAgentRunContext(runId: string): AgentRunContext | undefined {
  return getAgentRunRegistryState().contexts.get(runId);
}

/** Holds an existing run context only while its current execution awaits lane admission. */
export function retainQueuedAgentRunContext(
  runId: string,
  lifecycleGeneration: string,
): ((outcome: "admitted" | "abandoned") => void) | undefined {
  const state = getAgentRunRegistryState();
  const context = state.contexts.get(runId);
  if (
    !context ||
    context.lifecycleGeneration !== lifecycleGeneration ||
    state.lifecycleGeneration !== lifecycleGeneration
  ) {
    return undefined;
  }

  const leases = (state.queuedRunContextLeases ??= new WeakMap<AgentRunContext, number>());
  leases.set(context, (leases.get(context) ?? 0) + 1);
  let released = false;

  return (outcome) => {
    if (released) {
      return;
    }
    released = true;
    const remaining = (leases.get(context) ?? 0) - 1;
    if (remaining > 0) {
      leases.set(context, remaining);
    } else {
      leases.delete(context);
    }

    // A recycled run id or rotated lifecycle must not inherit the old queue's activity.
    if (
      outcome === "admitted" &&
      state.contexts.get(runId) === context &&
      context.lifecycleGeneration === lifecycleGeneration &&
      state.lifecycleGeneration === lifecycleGeneration
    ) {
      context.lastActiveAt = Date.now();
    }
  };
}

export function getAgentRunContextOwnership(runId: string): AgentRunContextOwnership | undefined {
  return getAgentRunRegistryState().owners.get(runId);
}

/** Records the latest next-check proposal on the matching paced cron run. */
export function recordCronNextCheckProposal(runId: string, jobId: string, delayMs: number): void {
  const context = getAgentRunContext(runId);
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
  const context = getAgentRunContext(runId);
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
  const state = getAgentRunRegistryState();
  const owners = state.owners.get(runId);
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
  const state = getAgentRunRegistryState();
  const runs: Array<{ runId: string; lifecycleGeneration: string }> = [];
  for (const [runId, context] of state.contexts) {
    const matches = context.sessionId
      ? context.sessionId === params.sessionId
      : context.sessionKey === params.sessionKey;
    if (matches && context.lifecycleGeneration === state.lifecycleGeneration) {
      runs.push({ runId, lifecycleGeneration: context.lifecycleGeneration });
    }
  }
  return runs.toSorted((a, b) =>
    a.runId === b.runId
      ? a.lifecycleGeneration.localeCompare(b.lifecycleGeneration)
      : a.runId.localeCompare(b.runId),
  );
}

export type ProjectedAgentRunIndex = {
  sessionKeys: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
};

export function buildProjectedAgentRunIndex(): ProjectedAgentRunIndex {
  const state = getAgentRunRegistryState();
  const sessionKeys = new Set<string>();
  const sessionIds = new Set<string>();
  for (const context of state.contexts.values()) {
    if (
      context.projectSessionActive !== true ||
      context.lifecycleGeneration !== state.lifecycleGeneration
    ) {
      continue;
    }
    if (context.sessionKey !== undefined) {
      sessionKeys.add(context.sessionKey);
    }
    if (context.sessionId !== undefined) {
      sessionIds.add(context.sessionId);
    }
  }
  return { sessionKeys, sessionIds };
}

export function hasProjectedAgentRunForSession(params: {
  sessionKeys: readonly string[];
  sessionId?: string;
  index?: ProjectedAgentRunIndex;
}): boolean {
  const index = params.index ?? buildProjectedAgentRunIndex();
  return (
    params.sessionKeys.some((sessionKey) => index.sessionKeys.has(sessionKey)) ||
    (params.sessionId !== undefined && index.sessionIds.has(params.sessionId))
  );
}

/** Clears context state for a run that has ended or been discarded. */
export function clearAgentRunContext(
  runId: string,
  lifecycleGeneration?: string,
  claimId?: string,
): void {
  const state = getAgentRunRegistryState();
  const existing = state.contexts.get(runId);
  if (lifecycleGeneration && existing && existing.lifecycleGeneration !== lifecycleGeneration) {
    return;
  }
  const owners = state.owners.get(runId);
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
      const wasClearRequested = owners.clearRequested;
      owners.clearRequested = true;
      for (const [ownerClaimId, listener] of owners.clearListeners ?? []) {
        listener(ownerClaimId);
      }
      if (!wasClearRequested) {
        bumpAgentRunIndexVersion();
      }
    }
    return;
  }
  const removed = state.contexts.delete(runId);
  state.sequenceResetHandler?.(runId);
  clearAgentRunUsage(runId, lifecycleGeneration ?? existing?.lifecycleGeneration);
  if (removed) {
    bumpAgentRunIndexVersion();
  }
}

/** Releases one tracked owner and clears its context after the final owner exits. */
export function releaseAgentRunContext(runId: string, claimId: string | undefined): void {
  if (!runId || !claimId) {
    return;
  }
  const state = getAgentRunRegistryState();
  const owners = state.owners.get(runId);
  if (!owners?.claimIds.delete(claimId)) {
    return;
  }
  const versionBeforeRelease = readAgentRunIndexVersion();
  owners.clearListeners?.delete(claimId);
  if (owners.exclusiveClaimId === claimId) {
    owners.exclusiveClaimId = undefined;
  }
  if (owners.claimIds.size > 0) {
    bumpAgentRunIndexVersion();
    return;
  }
  state.owners.delete(runId);
  if (owners.clearRequested || !owners.preserveAfterRelease) {
    clearAgentRunContext(runId, owners.lifecycleGeneration);
  }
  if (readAgentRunIndexVersion() === versionBeforeRelease) {
    bumpAgentRunIndexVersion();
  }
}

/** Sweeps orphaned run contexts that exceeded the given TTL. */
export function sweepStaleRunContexts(maxAgeMs = 30 * 60 * 1000): number {
  const state = getAgentRunRegistryState();
  const now = Date.now();
  let swept = 0;
  for (const [runId, context] of state.contexts) {
    // Queue capacity waits are live ownership, but never protect a retired lifecycle.
    if (
      context.lifecycleGeneration === state.lifecycleGeneration &&
      (state.queuedRunContextLeases?.get(context) ?? 0) > 0
    ) {
      continue;
    }
    // Use lastActiveAt (refreshed on every event) to avoid sweeping active runs.
    // Fall back to registeredAt, then treat missing timestamps as infinitely old.
    const lastSeen = context.lastActiveAt ?? context.registeredAt;
    const age = lastSeen ? now - lastSeen : Infinity;
    if (age > maxAgeMs) {
      state.contexts.delete(runId);
      state.sequenceResetHandler?.(runId);
      clearAgentRunUsage(runId, context.lifecycleGeneration);
      state.owners.delete(runId);
      swept += 1;
    }
  }
  if (swept > 0) {
    bumpAgentRunIndexVersion();
  }
  return swept;
}

export function resetAgentRunRegistryForTest(): void {
  const state = getAgentRunRegistryState();
  const hadRunContexts = state.contexts.size > 0;
  resetAgentRunUsageForTest();
  state.contexts.clear();
  state.owners.clear();
  state.queuedRunContextLeases = undefined;
  if (hadRunContexts) {
    bumpAgentRunIndexVersion();
  }
}
