import {
  getAgentRunContext,
  getAgentRunContextLifecycleToken,
} from "../infra/agent-run-registry.js";
import type { TrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

type RunProvenance = {
  actorType: "agent" | "system";
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
};

export type AgentAuditProjectionState = {
  runProvenance: Map<string, RunProvenance>;
  openRunProvenance: Map<string, RunProvenance>;
  authoritativeOpenProvenance: WeakMap<object, RunProvenance>;
  activeRunInstanceByRunId: Map<string, string>;
  seenRunInstances: Set<string>;
};

export const MAX_TRACKED_RUN_PROVENANCE = 1_024;
const MAX_TRACKED_ACTIVE_RUN_INSTANCES = MAX_TRACKED_RUN_PROVENANCE * 3;

export function buildRunInstance(runId: string, lifecycleGeneration?: string): string {
  return `${lifecycleGeneration ?? "unknown"}\0${runId}`;
}

export function createAgentAuditProjectionState(): AgentAuditProjectionState {
  return {
    runProvenance: new Map(),
    openRunProvenance: new Map(),
    authoritativeOpenProvenance: new WeakMap(),
    activeRunInstanceByRunId: new Map(),
    seenRunInstances: new Set(),
  };
}

function trimRunProvenance(state: AgentAuditProjectionState): void {
  while (state.runProvenance.size > MAX_TRACKED_RUN_PROVENANCE) {
    const oldestRunInstance = state.runProvenance.keys().next().value;
    if (oldestRunInstance === undefined) {
      break;
    }
    state.runProvenance.delete(oldestRunInstance);
    if (!state.openRunProvenance.has(oldestRunInstance)) {
      state.seenRunInstances.delete(oldestRunInstance);
    }
    for (const [trackedRunId, activeRunInstance] of state.activeRunInstanceByRunId) {
      if (
        activeRunInstance === oldestRunInstance &&
        !state.openRunProvenance.has(oldestRunInstance)
      ) {
        state.activeRunInstanceByRunId.delete(trackedRunId);
      }
    }
  }
}

function trimActiveRunInstances(state: AgentAuditProjectionState): void {
  while (state.activeRunInstanceByRunId.size > MAX_TRACKED_ACTIVE_RUN_INSTANCES) {
    const oldestRunId = state.activeRunInstanceByRunId.keys().next().value;
    if (oldestRunId === undefined) {
      break;
    }
    state.activeRunInstanceByRunId.delete(oldestRunId);
  }
}

function canActivateRunInstance(
  state: AgentAuditProjectionState,
  activeRunInstance: string | undefined,
  runInstance: string,
  hasLifecycleGeneration: boolean,
): boolean {
  // Generation-less starts cannot displace a live generated admission. Once
  // that admission closes, they must replace its retained delayed-tool pointer.
  return (
    hasLifecycleGeneration ||
    !activeRunInstance ||
    activeRunInstance === runInstance ||
    !state.openRunProvenance.has(activeRunInstance)
  );
}

export function rememberRunStart(
  state: AgentAuditProjectionState,
  runInstance: string,
  runId: string,
  provenance: RunProvenance,
  hasLifecycleGeneration: boolean,
  contextLifecycleToken?: object,
): RunProvenance {
  const authoritativeToken = getAuthoritativeRunContextToken(
    runInstance,
    runId,
    contextLifecycleToken,
  );
  if (authoritativeToken) {
    const remembered = state.authoritativeOpenProvenance.get(authoritativeToken) ?? provenance;
    state.authoritativeOpenProvenance.set(authoritativeToken, remembered);
    state.openRunProvenance.delete(runInstance);
    state.runProvenance.delete(runInstance);
    state.seenRunInstances.delete(runInstance);
    state.activeRunInstanceByRunId.delete(runId);
    state.activeRunInstanceByRunId.set(runId, runInstance);
    trimActiveRunInstances(state);
    return remembered;
  }
  if (state.seenRunInstances.has(runInstance)) {
    const remembered =
      state.openRunProvenance.get(runInstance) ??
      state.runProvenance.get(runInstance) ??
      provenance;
    state.openRunProvenance.set(runInstance, remembered);
    const activeRunInstance = state.activeRunInstanceByRunId.get(runId);
    if (canActivateRunInstance(state, activeRunInstance, runInstance, hasLifecycleGeneration)) {
      state.activeRunInstanceByRunId.delete(runId);
      state.activeRunInstanceByRunId.set(runId, runInstance);
      trimActiveRunInstances(state);
    }
    return remembered;
  }
  state.runProvenance.delete(runInstance);
  state.openRunProvenance.set(runInstance, provenance);
  state.seenRunInstances.add(runInstance);
  const activeRunInstance = state.activeRunInstanceByRunId.get(runId);
  if (canActivateRunInstance(state, activeRunInstance, runInstance, hasLifecycleGeneration)) {
    state.activeRunInstanceByRunId.delete(runId);
    state.activeRunInstanceByRunId.set(runId, runInstance);
    trimActiveRunInstances(state);
  }
  return provenance;
}

export function rememberRunTerminal(
  state: AgentAuditProjectionState,
  runInstance: string,
  runId: string,
  provenance: RunProvenance,
  contextLifecycleToken?: object,
): void {
  const authoritativeToken = getAuthoritativeRunContextToken(
    runInstance,
    runId,
    contextLifecycleToken,
  );
  const remembered =
    authoritativeToken !== undefined
      ? (state.authoritativeOpenProvenance.get(authoritativeToken) ?? provenance)
      : (state.openRunProvenance.get(runInstance) ??
        state.runProvenance.get(runInstance) ??
        provenance);
  if (authoritativeToken) {
    state.authoritativeOpenProvenance.set(authoritativeToken, remembered);
  }
  state.runProvenance.delete(runInstance);
  state.runProvenance.set(runInstance, remembered);
  const activeRunInstance = state.activeRunInstanceByRunId.get(runId);
  if (!activeRunInstance || activeRunInstance === runInstance) {
    // Refresh completed generated runs so their ambiguity guard survives
    // context retirement until the bounded completed-history entry expires.
    state.activeRunInstanceByRunId.delete(runId);
    state.activeRunInstanceByRunId.set(runId, runInstance);
    trimActiveRunInstances(state);
  }
  trimRunProvenance(state);
}

export function forgetOpenRun(
  state: AgentAuditProjectionState,
  runInstance: string,
  runId: string,
): void {
  state.openRunProvenance.delete(runInstance);
  if (
    !state.runProvenance.has(runInstance) &&
    state.activeRunInstanceByRunId.get(runId) === runInstance
  ) {
    state.activeRunInstanceByRunId.delete(runId);
  }
  if (!state.runProvenance.has(runInstance)) {
    state.seenRunInstances.delete(runInstance);
  }
}

export function forgetAuthoritativeOpenRun(
  state: AgentAuditProjectionState,
  runInstance: string,
  runId: string,
  contextLifecycleToken?: object,
): void {
  const token = getAuthoritativeRunContextToken(runInstance, runId, contextLifecycleToken);
  if (token) {
    state.authoritativeOpenProvenance.delete(token);
  }
}

export function retainAuthoritativeOpenRunForRetirement(
  state: AgentAuditProjectionState,
  runInstance: string,
  runId: string,
  contextLifecycleToken?: object,
): boolean {
  const token = contextLifecycleToken ?? getAuthoritativeRunContextToken(runInstance, runId);
  const provenance = token ? state.authoritativeOpenProvenance.get(token) : undefined;
  if (!token || !provenance) {
    return false;
  }
  // The recorder synchronously enrolls this strong fallback in its bounded
  // retired-run set; callers must not retain it without applying that cap.
  state.openRunProvenance.set(runInstance, provenance);
  state.seenRunInstances.add(runInstance);
  state.activeRunInstanceByRunId.delete(runId);
  state.activeRunInstanceByRunId.set(runId, runInstance);
  trimActiveRunInstances(state);
  return true;
}

export function adoptAuthoritativeOpenRunProvenance(
  state: AgentAuditProjectionState,
  runInstance: string,
  contextLifecycleToken: object,
): void {
  const provenance = state.openRunProvenance.get(runInstance);
  if (provenance && !state.authoritativeOpenProvenance.has(contextLifecycleToken)) {
    state.authoritativeOpenProvenance.set(contextLifecycleToken, provenance);
  }
}

export function hasAuthoritativeRunContext(
  runInstance: string,
  runId: string,
  contextLifecycleToken?: object,
): boolean {
  return getAuthoritativeRunContextToken(runInstance, runId, contextLifecycleToken) !== undefined;
}

export function getAuthoritativeRunContextToken(
  runInstance: string,
  runId: string,
  contextLifecycleToken?: object,
): object | undefined {
  if (contextLifecycleToken) {
    return contextLifecycleToken;
  }
  const separator = runInstance.indexOf("\0");
  const lifecycleGeneration = separator >= 0 ? runInstance.slice(0, separator) : "unknown";
  return lifecycleGeneration === "unknown"
    ? undefined
    : getAgentRunContextLifecycleToken(runId, lifecycleGeneration);
}

export function deriveProvenance(event: {
  agentId?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
}): RunProvenance {
  const sessionKey = nonEmptyString(event.sessionKey);
  const sessionId = nonEmptyString(event.sessionId);
  const eventAgentId = nonEmptyString(event.agentId);
  const sessionAgentId = sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined;
  const agentId = eventAgentId ?? sessionAgentId ?? "unknown";
  const actorType = eventAgentId || sessionAgentId ? "agent" : "system";
  return { actorType, agentId, sessionKey, sessionId };
}

export function resolveProvenance(
  state: AgentAuditProjectionState,
  runInstance: string,
  event: { agentId?: unknown; sessionKey?: unknown; sessionId?: unknown },
  contextLifecycleToken?: object,
): RunProvenance {
  const separator = runInstance.indexOf("\0");
  const lifecycleGeneration = separator >= 0 ? runInstance.slice(0, separator) : "unknown";
  const runId = separator >= 0 ? runInstance.slice(separator + 1) : runInstance;
  const context = getAgentRunContext(runId);
  const authoritativeToken = getAuthoritativeRunContextToken(
    runInstance,
    runId,
    contextLifecycleToken,
  );
  const registered =
    lifecycleGeneration !== "unknown" && context?.lifecycleGeneration === lifecycleGeneration
      ? deriveProvenance({
          agentId: context.attribution?.agentId ?? context.agentId,
          sessionKey: context.attribution?.sessionKey ?? context.sessionKey,
          sessionId: context.attribution?.sessionId ?? context.sessionId,
        })
      : undefined;
  if (authoritativeToken) {
    return (
      state.authoritativeOpenProvenance.get(authoritativeToken) ??
      registered ??
      deriveProvenance(event)
    );
  }
  return (
    state.openRunProvenance.get(runInstance) ??
    state.runProvenance.get(runInstance) ??
    registered ??
    deriveProvenance(event)
  );
}

export function resolveToolProvenance(
  state: AgentAuditProjectionState,
  runId: string,
  event: TrustedToolExecutionEvent,
  lifecycleGeneration?: string,
  contextLifecycleToken?: object,
): { provenance: RunProvenance; lifecycleGeneration?: string } {
  const registeredLifecycleGeneration = getAgentRunContext(runId)?.lifecycleGeneration;
  const activeRunInstance = state.activeRunInstanceByRunId.get(runId);
  const activeOpenRunInstance =
    activeRunInstance && state.openRunProvenance.has(activeRunInstance)
      ? activeRunInstance
      : undefined;
  const runInstance = lifecycleGeneration
    ? buildRunInstance(runId, lifecycleGeneration)
    : (activeOpenRunInstance ??
      (registeredLifecycleGeneration
        ? buildRunInstance(runId, registeredLifecycleGeneration)
        : (activeRunInstance ?? buildRunInstance(runId))));
  const separator = runInstance.indexOf("\0");
  const resolvedLifecycleGeneration =
    separator >= 0 && runInstance.slice(0, separator) !== "unknown"
      ? runInstance.slice(0, separator)
      : undefined;
  const observed = resolveProvenance(state, runInstance, event, contextLifecycleToken);
  const authoritativeToken = getAuthoritativeRunContextToken(
    runInstance,
    runId,
    contextLifecycleToken,
  );
  const remembered =
    authoritativeToken !== undefined
      ? state.authoritativeOpenProvenance.get(authoritativeToken)
      : (state.openRunProvenance.get(runInstance) ?? state.runProvenance.get(runInstance));
  // Lifecycle start owns canonical run identity. Once remembered, tool
  // diagnostics cannot fill unknown fields or replace the admitted principal.
  return {
    provenance: remembered ?? observed,
    lifecycleGeneration: resolvedLifecycleGeneration,
  };
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function trimUnownedOpenRuns(params: {
  state: AgentAuditProjectionState;
  runInstances: Set<string>;
  pendingTerminals: ReadonlyMap<string, unknown>;
  rejectedRunInstances: ReadonlyMap<string, unknown>;
  rejectedTerminals: ReadonlyMap<string, { runInstance: string }>;
  openRunInstances: Set<string>;
  rejectedStartRunInstances: Set<string>;
  attemptStartSequences: Map<string, number>;
  attemptEpochs: Map<string, number>;
  clearPending: (runInstance: string) => void;
  forgetRejectedAttempt: (attemptKey: string) => void;
}): void {
  while (params.runInstances.size > MAX_TRACKED_RUN_PROVENANCE) {
    const runInstance =
      [...params.runInstances].find(
        (candidate) =>
          !params.pendingTerminals.has(candidate) && !params.rejectedRunInstances.has(candidate),
      ) ?? params.runInstances.values().next().value;
    if (runInstance === undefined) {
      return;
    }
    const runId = runInstance.slice(runInstance.indexOf("\0") + 1);
    params.clearPending(runInstance);
    for (const [attemptKey, rejected] of params.rejectedTerminals) {
      if (rejected.runInstance === runInstance) {
        params.forgetRejectedAttempt(attemptKey);
      }
    }
    params.runInstances.delete(runInstance);
    forgetOpenRun(params.state, runInstance, runId);
    params.openRunInstances.delete(runInstance);
    params.rejectedStartRunInstances.delete(runInstance);
    params.attemptStartSequences.delete(runInstance);
    params.attemptEpochs.delete(runInstance);
  }
}
