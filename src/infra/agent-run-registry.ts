// Owns process-local agent run context, ownership, and projection state.
import { randomUUID } from "node:crypto";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerListener } from "../shared/listeners.js";
import {
  AgentRunApprovalLeases,
  type AgentRunApprovalClosureReason,
} from "./agent-run-approval-leases.js";
import type { AgentRunDelegatedAuthority } from "./agent-run-authority.types.js";
import type {
  AgentRunContext,
  AgentRunContextOwnership,
  AgentRunRegistryState,
  ProjectedAgentRunIndex,
  ProjectedAgentRunState,
} from "./agent-run-registry.types.js";
import { clearAgentRunUsage, resetAgentRunUsageForTest } from "./agent-run-usage.js";

export type { AgentRunDelegatedAuthority } from "./agent-run-authority.types.js";
export type { ProjectedAgentRunIndex } from "./agent-run-registry.types.js";

const AGENT_RUN_REGISTRY_STATE_KEY = Symbol.for("openclaw.agentRunRegistry.state");

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

/** Reads the process-local version of the active-run projection inputs. */
export function readAgentRunIndexVersion(): number {
  return getAgentRunRegistryState().version;
}

export function getAgentRunLifecycleGeneration(): string {
  return getAgentRunRegistryState().lifecycleGeneration;
}

export function rotateAgentRunRegistryLifecycleGeneration(): string {
  const state = getAgentRunRegistryState();
  for (const context of state.contexts.values()) {
    const authority = context.delegatedAuthority;
    if (authority) {
      delete context.delegatedAuthority;
      delete context.assertSourceCurrent;
      notifyDelegatedAuthorityClosed(state, authority);
    }
  }
  state.lifecycleGeneration = randomUUID();
  bumpAgentRunIndexVersion();
  return state.lifecycleGeneration;
}

function notifyDelegatedAuthorityClosed(
  state: AgentRunRegistryState,
  authority: AgentRunDelegatedAuthority,
  approvalReason?: AgentRunApprovalClosureReason,
): void {
  if (!approvalReason) {
    const context = state.contexts.get(authority.operationalRunInstance.runId);
    context?.approvalLeases?.close(authority);
  }
  // One observer cannot block closure or prevent other owners from canceling work.
  for (const handler of state.delegatedAuthorityClosedHandlers ?? []) {
    try {
      handler(authority, approvalReason);
    } catch {
      // Approval settlement cannot block the owner transition.
    }
  }
}

/** Observe exact delegated-authority closure without displacing other lifecycle owners. */
export function registerAgentRunDelegatedAuthorityClosedHandler(
  handler: (
    authority: AgentRunDelegatedAuthority,
    approvalReason?: AgentRunApprovalClosureReason,
  ) => void,
): () => void {
  const handlers = (getAgentRunRegistryState().delegatedAuthorityClosedHandlers ??= new Set());
  return registerListener(handlers, handler);
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
    state.contexts.set(runId, {
      ...context,
      // Scheduler leases belong to this instance, never copied metadata.
      capacityWaits: undefined,
      lifecycleGeneration,
      registeredAt: context.registeredAt ?? Date.now(),
    });
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
  if (context.projectSessionMessages !== undefined) {
    existing.projectSessionMessages = context.projectSessionMessages;
  }
  if (context.mainSessionRestartRecovery === true) {
    existing.mainSessionRestartRecovery = true;
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
    protectFromSweep?: boolean;
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
      if (options.protectFromSweep) {
        currentOwners.sweepProtectedClaimIds.add(claimId);
      }
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
        sweepProtectedClaimIds: new Set(options.protectFromSweep ? [claimId] : []),
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
  state.contexts.set(runId, {
    ...context,
    capacityWaits: undefined,
    lifecycleGeneration,
    registeredAt: context.registeredAt ?? Date.now(),
  });
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

/** Claims approval authority for the exact admitted operational execution. */
export function claimAgentRunDelegatedAuthority(
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }>,
  assertSourceCurrent?: () => void,
): AgentRunDelegatedAuthority {
  const instanceId = operationalRunInstance.instanceId.trim();
  const runId = operationalRunInstance.runId.trim();
  if (!instanceId || !runId) {
    throw new Error("agent run delegated authority requires an operational run instance");
  }
  const state = getAgentRunRegistryState();
  const currentInstance =
    operationalRunInstance.instanceId === instanceId && operationalRunInstance.runId === runId
      ? operationalRunInstance
      : Object.freeze({ instanceId, runId });
  const bound = state.contexts.get(runId);
  // Check the binding before callbacks or liveness validation can retire it.
  if (
    bound?.delegatedAuthority?.operationalRunInstance.instanceId === instanceId &&
    bound.assertSourceCurrent !== assertSourceCurrent
  ) {
    throw new Error("agent run source authority is already bound");
  }
  assertSourceCurrent?.();
  const lifecycleGeneration = state.lifecycleGeneration;
  const active = getActiveAgentRunDelegatedAuthority(currentInstance);
  if (active) {
    return active;
  }
  const existing = state.contexts.get(runId)?.delegatedAuthority;
  if (existing) {
    // Same-id replacement retires only the prior operational authority. Other
    // legitimate run-context owners continue until their own lifecycle exits.
    releaseAgentRunContext(runId, existing.claimId);
  }
  const claimId = claimAgentRunContext(
    runId,
    { lifecycleGeneration, lastActiveAt: Date.now() },
    {
      trackOwner: true,
      protectFromSweep: true,
      onClearRequested: (requestedClaimId) => {
        releaseAgentRunContext(runId, requestedClaimId);
      },
    },
  );
  if (!claimId) {
    throw new Error("agent run delegated authority could not claim the operational execution");
  }
  const authority = Object.freeze({
    operationalRunInstance: currentInstance,
    lifecycleGeneration,
    claimId,
  });
  const context = state.contexts.get(runId);
  if (!context || context.lifecycleGeneration !== lifecycleGeneration) {
    releaseAgentRunContext(runId, claimId);
    throw new Error("agent run delegated authority lost its lifecycle during admission");
  }
  context.delegatedAuthority = authority;
  context.assertSourceCurrent = assertSourceCurrent;
  return authority;
}

/** Returns authority only while the exact lifecycle owner still holds its claim. */
export function getActiveAgentRunDelegatedAuthority(
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }>,
): AgentRunDelegatedAuthority | undefined {
  const context = getAgentRunRegistryState().contexts.get(operationalRunInstance.runId);
  const authority = context?.delegatedAuthority;
  if (
    !context ||
    !authority ||
    authority.operationalRunInstance.instanceId !== operationalRunInstance.instanceId ||
    authority.operationalRunInstance.runId !== operationalRunInstance.runId ||
    // A clear request is projection state; the exact live claim still owns authority.
    getAgentRunContextOwnerStatus(
      operationalRunInstance.runId,
      authority.claimId,
      authority.lifecycleGeneration,
    ) === undefined
  ) {
    return undefined;
  }
  try {
    context.assertSourceCurrent?.();
    return getAgentRunContext(operationalRunInstance.runId) === context &&
      context.delegatedAuthority === authority &&
      getAgentRunContextOwnerStatus(
        operationalRunInstance.runId,
        authority.claimId,
        authority.lifecycleGeneration,
      ) !== undefined
      ? authority
      : undefined;
  } catch {
    // A copied approval cannot outlive its source; retire the exact owner at detection.
    releaseAgentRunContext(operationalRunInstance.runId, authority.claimId);
    return undefined;
  }
}

export function validateAgentRunDelegatedAuthority(authority: AgentRunDelegatedAuthority): boolean {
  const active = getActiveAgentRunDelegatedAuthority(authority.operationalRunInstance);
  if (!active || active.lifecycleGeneration !== authority.lifecycleGeneration) {
    return false;
  }
  const leases = getAgentRunContext(authority.operationalRunInstance.runId)?.approvalLeases;
  return (
    active.claimId === authority.claimId || leases?.isActive(active, authority.claimId) === true
  );
}

/** Narrows an admitted run to one live tool generation without replacing its outer claim. */
export function claimAgentRunApprovalAuthority(
  parent: AgentRunDelegatedAuthority,
  inputSignals: readonly AbortSignal[],
): AgentRunDelegatedAuthority {
  const state = getAgentRunRegistryState();
  const context = state.contexts.get(parent.operationalRunInstance.runId);
  if (context?.delegatedAuthority !== parent || !validateAgentRunDelegatedAuthority(parent)) {
    throw new Error("agent run approval authority is no longer active");
  }
  const leases = (context.approvalLeases ??= new AgentRunApprovalLeases((authority, reason) =>
    notifyDelegatedAuthorityClosed(state, authority, reason),
  ));
  return leases.claim(parent, inputSignals);
}

/** Compare-releases only the exact authority owned by one admitted execution. */
export function releaseAgentRunDelegatedAuthority(authority: AgentRunDelegatedAuthority): boolean {
  const { runId, instanceId } = authority.operationalRunInstance;
  const context = getAgentRunContext(runId);
  const active = context?.delegatedAuthority;
  // Cleanup compares ownership without asking a revoked source for permission to retire.
  if (
    !context ||
    !active ||
    active.operationalRunInstance.instanceId !== instanceId ||
    active.lifecycleGeneration !== authority.lifecycleGeneration ||
    getAgentRunContextOwnerStatus(runId, active.claimId, active.lifecycleGeneration) === undefined
  ) {
    return false;
  }
  if (active.claimId !== authority.claimId) {
    return context.approvalLeases?.release(authority.claimId) === true;
  }
  releaseAgentRunContext(runId, authority.claimId);
  return true;
}

/** Lists active runs bound to one current session identity. */
export function listAgentRunsForSession(params: {
  sessionKey: string;
  sessionId?: string;
}): Array<{ runId: string; lifecycleGeneration: string }> {
  const state = getAgentRunRegistryState();
  const runs: Array<{ runId: string; lifecycleGeneration: string }> = [];
  for (const [runId, context] of state.contexts) {
    const matches =
      context.sessionKey === params.sessionKey &&
      (!context.sessionId || context.sessionId === params.sessionId);
    if (matches && context.lifecycleGeneration === state.lifecycleGeneration) {
      runs.push({ runId, lifecycleGeneration: context.lifecycleGeneration });
    }
  }
  return runs.toSorted((a, b) => a.runId.localeCompare(b.runId));
}

function projectedRunIdentity(agentId: string, value: string): string {
  return `${normalizeAgentId(agentId)}\0${value}`;
}

export function buildProjectedAgentRunIndex(): ProjectedAgentRunIndex {
  const state = getAgentRunRegistryState();
  const sessionKeys = new Map<string, ProjectedAgentRunState>();
  const sessionIds = new Map<string, ProjectedAgentRunState>();
  const ownerlessSessionKeys = new Map<string, ProjectedAgentRunState>();
  const ownerlessSessionIds = new Map<string, ProjectedAgentRunState>();
  const add = (
    index: Map<string, ProjectedAgentRunState>,
    key: string,
    status: ProjectedAgentRunState,
  ) => {
    const previous = index.get(key);
    if (previous !== "running" && !(previous === "queued" && status === "capacity-wait")) {
      index.set(key, status);
    }
  };
  for (const context of state.contexts.values()) {
    const queued = (context.capacityWaits?.size ?? 0) > 0;
    if (
      context.lifecycleGeneration !== state.lifecycleGeneration ||
      (context.projectSessionActive !== true &&
        (!queued ||
          context.projectSessionActive === false ||
          context.projectSessionLifecycle === false))
    ) {
      continue;
    }
    const status = !queued
      ? "running"
      : context.projectSessionActive === true
        ? "queued"
        : "capacity-wait";
    const agentId = context.agentId ?? parseAgentSessionKey(context.sessionKey)?.agentId;
    if (context.sessionKey !== undefined && agentId) {
      add(sessionKeys, projectedRunIdentity(agentId, context.sessionKey), status);
    } else if (context.sessionKey !== undefined) {
      add(ownerlessSessionKeys, context.sessionKey, status);
    }
    if (context.sessionId !== undefined && agentId) {
      add(sessionIds, projectedRunIdentity(agentId, context.sessionId), status);
    } else if (context.sessionId !== undefined) {
      add(ownerlessSessionIds, context.sessionId, status);
    }
  }
  return { sessionKeys, sessionIds, ownerlessSessionKeys, ownerlessSessionIds };
}

export function resolveProjectedAgentRunProgressState(params: {
  sessionKeys: readonly string[];
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  index?: ProjectedAgentRunIndex;
}): ProjectedAgentRunState | undefined {
  const index = params.index ?? buildProjectedAgentRunIndex();
  const agentId =
    params.agentId ??
    params.sessionKeys.flatMap((key) => parseAgentSessionKey(key)?.agentId ?? [])[0] ??
    params.defaultAgentId;
  if (!agentId) {
    return undefined;
  }
  const mayAdoptOwnerless =
    params.defaultAgentId !== undefined &&
    normalizeAgentId(agentId) === normalizeAgentId(params.defaultAgentId);
  const statuses = params.sessionKeys.flatMap((sessionKey) => [
    index.sessionKeys.get(projectedRunIdentity(agentId, sessionKey)),
    ...(mayAdoptOwnerless ? [index.ownerlessSessionKeys.get(sessionKey)] : []),
  ]);
  if (params.sessionId !== undefined) {
    statuses.push(index.sessionIds.get(projectedRunIdentity(agentId, params.sessionId)));
    if (mayAdoptOwnerless) {
      statuses.push(index.ownerlessSessionIds.get(params.sessionId));
    }
  }
  return statuses.includes("running")
    ? "running"
    : statuses.includes("queued")
      ? "queued"
      : statuses.includes("capacity-wait")
        ? "capacity-wait"
        : undefined;
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
        // A run-id-only terminal projection cannot identify a reused logical
        // execution. Its exact outer close or abort owns capability revocation.
        if (ownerClaimId === existing?.delegatedAuthority?.claimId) {
          continue;
        }
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
  const context = state.contexts.get(runId);
  const authority = context?.delegatedAuthority;
  if (context && authority?.claimId === claimId) {
    delete context.delegatedAuthority;
    delete context.assertSourceCurrent;
    notifyDelegatedAuthorityClosed(state, authority);
  }
  owners.sweepProtectedClaimIds.delete(claimId);
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
    const owners = state.owners.get(runId);
    if (
      owners?.lifecycleGeneration === state.lifecycleGeneration &&
      owners.sweepProtectedClaimIds.size > 0
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
  for (const context of state.contexts.values()) {
    context.approvalLeases?.close();
  }
  resetAgentRunUsageForTest();
  state.contexts.clear();
  state.owners.clear();
  state.queuedRunContextLeases = undefined;
  if (hadRunContexts) {
    bumpAgentRunIndexVersion();
  }
}
