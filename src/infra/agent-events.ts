// Stores and broadcasts agent lifecycle and streaming events.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import {
  captureAgentEventContextLifecycleToken,
  getAgentEventContextLifecycleToken,
} from "./agent-event-execution-context.js";
import { hasInvalidLifecycleStartTimestamp } from "./agent-event-lifecycle.js";
import { createAgentRunStaleLifecycleError } from "./agent-lifecycle-error.js";
import {
  captureAgentRunExecutionContextLifecycleToken,
  getAgentRunExecutionContextLifecycleToken,
  getAgentRunExecutionLifecycleGeneration,
  runOncePerAgentRun,
  withAgentRunLifecycleGeneration,
} from "./agent-run-execution-context.js";
import {
  claimAgentRunContext,
  getAgentRunContext,
  getAgentRunContextLifecycleToken,
  getAgentRunContextOwnership,
  getAgentRunLifecycleGeneration,
  registerAgentRunSequenceResetHandler,
  releaseAgentRunContext,
  retainActiveAgentRunContext,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "./agent-run-registry.js";

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
  readonly projectSessionLifecycle?: boolean;
};

type AgentEventState = {
  seqByRun: Map<string, number>;
  retiredSeqByRunInstance: Map<string, number>;
  listeners: Set<(evt: AgentEventRuntimePayload) => void>;
  auditListeners: Set<(evt: AgentEventPayload) => void>;
  syntheticRunClaims?: Map<
    string,
    {
      claimId: string;
      contextLifecycleToken?: object;
      lifecycleGeneration: string;
      releaseLease: () => void;
    }
  >;
  lifecycleRotationHandlers?: Map<string, (lifecycleGeneration: string) => void>;
};

const AGENT_EVENT_STATE_KEY = Symbol.for("openclaw.agentEvents.state");
const MAX_RETIRED_AGENT_EVENT_SEQUENCES = 4_096;
const MAX_SYNTHETIC_AGENT_RUN_CLAIMS = 4_096;

function buildAgentRunInstanceKey(runId: string, lifecycleGeneration: string): string {
  return `${lifecycleGeneration}\0${runId}`;
}

function getAgentEventState(): AgentEventState {
  return resolveGlobalSingleton<AgentEventState>(AGENT_EVENT_STATE_KEY, () => ({
    seqByRun: new Map<string, number>(),
    retiredSeqByRunInstance: new Map<string, number>(),
    listeners: new Set<(evt: AgentEventRuntimePayload) => void>(),
    auditListeners: new Set<(evt: AgentEventPayload) => void>(),
  }));
}

function retainRetiredAgentEventSequence(
  state: AgentEventState,
  runInstance: string,
  sequence: number,
): void {
  state.retiredSeqByRunInstance.delete(runInstance);
  state.retiredSeqByRunInstance.set(runInstance, sequence);
  while (state.retiredSeqByRunInstance.size > MAX_RETIRED_AGENT_EVENT_SEQUENCES) {
    const oldest = state.retiredSeqByRunInstance.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    state.retiredSeqByRunInstance.delete(oldest);
  }
}

registerAgentRunSequenceResetHandler((runId, lifecycleGeneration) => {
  const state = getAgentEventState();
  const runInstance = lifecycleGeneration
    ? buildAgentRunInstanceKey(runId, lifecycleGeneration)
    : undefined;
  const sequence =
    (runInstance ? state.retiredSeqByRunInstance.get(runInstance) : undefined) ??
    state.seqByRun.get(runId);
  state.seqByRun.delete(runId);
  const syntheticClaim = state.syntheticRunClaims?.get(runId);
  if (!lifecycleGeneration || syntheticClaim?.lifecycleGeneration === lifecycleGeneration) {
    syntheticClaim?.releaseLease();
    state.syntheticRunClaims?.delete(runId);
  }
  if (!runInstance) {
    return;
  }
  // Same-generation rebounds continue directly from the retired-instance map,
  // so a later clear must carry that exact counter forward instead of erasing it.
  state.retiredSeqByRunInstance.delete(runInstance);
  if (sequence !== undefined) {
    // Context cleanup can precede an old generation's final audit event.
    // Retain only its ordering, bounded above, so the terminal cannot replay at seq 1.
    retainRetiredAgentEventSequence(state, runInstance, sequence);
  }
});

export { runOncePerAgentRun, withAgentRunLifecycleGeneration };

export function getAgentEventLifecycleGeneration(): string {
  return getAgentRunLifecycleGeneration();
}

export function isAgentEventLifecycleGenerationCurrent(lifecycleGeneration: string): boolean {
  return lifecycleGeneration === getAgentRunLifecycleGeneration();
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
  throw createAgentRunStaleLifecycleError();
}

/** Captures immutable lifecycle ownership for one admitted execution. */
export function captureAgentRunLifecycleGeneration(runId: string): string {
  return (
    getAgentRunExecutionLifecycleGeneration() ??
    getAgentRunContext(runId)?.lifecycleGeneration ??
    getAgentRunLifecycleGeneration()
  );
}

function captureAgentRunEventContextLifecycleToken(
  runId: string,
  lifecycleGeneration: string | undefined,
): object | undefined {
  const inherited = getAgentRunExecutionContextLifecycleToken(runId);
  if (inherited || !lifecycleGeneration) {
    return inherited;
  }
  const registered = getAgentRunContextLifecycleToken(runId, lifecycleGeneration);
  if (registered) {
    captureAgentRunExecutionContextLifecycleToken(runId, lifecycleGeneration, registered);
  }
  return registered;
}

/** Starts a new ownership generation before an in-process gateway restart. */
export function rotateAgentEventLifecycleGeneration(): string {
  const state = getAgentEventState();
  const lifecycleGeneration = rotateAgentRunRegistryLifecycleGeneration();
  const syntheticRunClaims = [...(state.syntheticRunClaims?.entries() ?? [])];
  for (const [runId, syntheticClaim] of syntheticRunClaims) {
    releaseSyntheticAgentRunClaim(runId, syntheticClaim.claimId);
  }
  // Rotation is the liveness choke point: after it returns, no prior-generation
  // owner is operationally reachable. Recovery and runtime consumers therefore
  // agree that only current-generation owners can drive or receive work.
  const errors: unknown[] = [];
  notifyListeners(state.lifecycleRotationHandlers?.values() ?? [], lifecycleGeneration, (error) =>
    errors.push(error),
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to retire stale agent lifecycle owners");
  }
  return lifecycleGeneration;
}

function enrichAgentEvent(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  claimId?: string,
  continueRetiredSequence = false,
): AgentEventRuntimePayload | undefined {
  const state = getAgentEventState();
  const currentLifecycleGeneration = getAgentRunLifecycleGeneration();
  const owners = getAgentRunContextOwnership(event.runId);
  if (claimId !== undefined) {
    if (
      owners?.lifecycleGeneration !== currentLifecycleGeneration ||
      owners.exclusiveClaimId !== claimId ||
      !owners.claimIds.has(claimId) ||
      owners.clearRequested
    ) {
      return undefined;
    }
  } else if (
    owners?.lifecycleGeneration === currentLifecycleGeneration &&
    owners.exclusiveClaimId
  ) {
    return undefined;
  }
  const context = getAgentRunContext(event.runId);
  const executionLifecycleGeneration =
    event.lifecycleGeneration ?? getAgentRunExecutionLifecycleGeneration();
  const ownedLifecycleGeneration = executionLifecycleGeneration ?? context?.lifecycleGeneration;
  const contextLifecycleToken = captureAgentRunEventContextLifecycleToken(
    event.runId,
    ownedLifecycleGeneration,
  );
  const registeredContextLifecycleToken =
    context?.lifecycleGeneration === ownedLifecycleGeneration && ownedLifecycleGeneration
      ? getAgentRunContextLifecycleToken(event.runId, ownedLifecycleGeneration)
      : undefined;
  const contextMatchesExecution =
    !contextLifecycleToken ||
    !registeredContextLifecycleToken ||
    contextLifecycleToken === registeredContextLifecycleToken;
  if (
    executionLifecycleGeneration &&
    context?.lifecycleGeneration &&
    executionLifecycleGeneration !== context.lifecycleGeneration
  ) {
    return undefined;
  }
  if (ownedLifecycleGeneration && ownedLifecycleGeneration !== currentLifecycleGeneration) {
    return undefined;
  }
  if (!contextMatchesExecution && !continueRetiredSequence) {
    return undefined;
  }
  if (hasInvalidLifecycleStartTimestamp(event.stream, event.data)) {
    return undefined;
  }
  const matchingContext = contextMatchesExecution ? context : undefined;
  const lifecycleGeneration =
    event.stream === "lifecycle"
      ? (ownedLifecycleGeneration ?? currentLifecycleGeneration)
      : ownedLifecycleGeneration;
  const retiredRunInstance =
    continueRetiredSequence && lifecycleGeneration
      ? buildAgentRunInstanceKey(event.runId, lifecycleGeneration)
      : undefined;
  const retiredSequence = retiredRunInstance
    ? state.retiredSeqByRunInstance.get(retiredRunInstance)
    : undefined;
  let data = event.data;
  if (matchingContext && event.stream === "lifecycle") {
    if (data.phase === "start") {
      matchingContext.lifecycleStartedAt = data.startedAt as number;
    } else if (
      (data.phase === "end" || data.phase === "error") &&
      data.startedAt === undefined &&
      matchingContext.lifecycleStartedAt !== undefined
    ) {
      // Preserve this run's identity after a newer run takes over its session.
      data = { ...data, startedAt: matchingContext.lifecycleStartedAt };
    }
  }
  const nextSeq = (retiredSequence ?? state.seqByRun.get(event.runId) ?? 0) + 1;
  if (retiredRunInstance && retiredSequence !== undefined) {
    retainRetiredAgentEventSequence(state, retiredRunInstance, nextSeq);
  } else {
    state.seqByRun.set(event.runId, nextSeq);
  }
  if (matchingContext) {
    matchingContext.lastActiveAt = Date.now();
  }
  const isControlUiVisible = matchingContext?.isControlUiVisible ?? true;
  const eventSessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
  const deliverySessionKey = eventSessionKey ?? matchingContext?.sessionKey;
  // Hidden channel-routed runs should not leak live assistant/tool traffic into
  // Control UI, but lifecycle events still need the session key so gateway
  // listeners can persist terminal session state even if run-context lookup is
  // unavailable by the time the terminal event arrives. Terminal failures are
  // emitted on the lifecycle stream with `phase: "error"`; the separate error
  // stream remains redacted for hidden runs because it is observational only.
  const preserveSessionKey = isControlUiVisible || event.stream === "lifecycle";
  const sessionKey = preserveSessionKey
    ? (eventSessionKey ?? matchingContext?.sessionKey)
    : undefined;
  // Stamp lifecycle events with the owning sessionId (see AgentEventPayload) at
  // emit time, since the run context can be cleared before the terminal persists.
  const sessionId =
    event.stream === "lifecycle"
      ? (event.sessionId ?? matchingContext?.sessionId)
      : event.sessionId;
  const agentId = event.agentId ?? matchingContext?.agentId;
  const enriched: AgentEventRuntimePayload = {
    ...event,
    data,
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
  if (contextLifecycleToken) {
    captureAgentEventContextLifecycleToken(enriched, contextLifecycleToken);
  }
  if (matchingContext?.isControlUiVisible !== undefined) {
    Object.defineProperty(enriched, "controlUiVisible", {
      value: matchingContext.isControlUiVisible,
      enumerable: false,
    });
  }
  if (matchingContext?.projectSessionLifecycle !== undefined) {
    Object.defineProperty(enriched, "projectSessionLifecycle", {
      value: matchingContext.projectSessionLifecycle,
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

function enrichOwnedStaleAgentAuditEvent(
  event: Omit<AgentEventPayload, "seq" | "ts">,
): AgentEventPayload | undefined {
  if (
    event.stream !== "lifecycle" ||
    (event.data.phase !== "start" && event.data.phase !== "end" && event.data.phase !== "error")
  ) {
    return undefined;
  }
  const state = getAgentEventState();
  const inheritedLifecycleGeneration = getAgentRunExecutionLifecycleGeneration();
  const lifecycleGeneration = event.lifecycleGeneration ?? inheritedLifecycleGeneration;
  const currentLifecycleGeneration = getAgentRunLifecycleGeneration();
  if (!lifecycleGeneration || lifecycleGeneration === currentLifecycleGeneration) {
    return undefined;
  }
  const context = getAgentRunContext(event.runId);
  const runInstance = buildAgentRunInstanceKey(event.runId, lifecycleGeneration);
  const retiredSequence = state.retiredSeqByRunInstance.get(runInstance);
  const matchingContext =
    context?.lifecycleGeneration === lifecycleGeneration ? context : undefined;
  if (
    (context && !matchingContext && retiredSequence === undefined) ||
    (!context && inheritedLifecycleGeneration !== lifecycleGeneration) ||
    hasInvalidLifecycleStartTimestamp(event.stream, event.data)
  ) {
    return undefined;
  }
  const nextSeq =
    (retiredSequence ?? (matchingContext ? state.seqByRun.get(event.runId) : undefined) ?? 0) + 1;
  if (retiredSequence !== undefined || !matchingContext) {
    retainRetiredAgentEventSequence(state, runInstance, nextSeq);
  } else {
    state.seqByRun.set(event.runId, nextSeq);
  }
  const sessionKey =
    (typeof event.sessionKey === "string" && event.sessionKey.trim()
      ? event.sessionKey
      : undefined) ?? matchingContext?.sessionKey;
  const sessionId = event.sessionId ?? matchingContext?.sessionId;
  const agentId = event.agentId ?? matchingContext?.agentId;
  const enriched: AgentEventPayload = {
    ...event,
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
    seq: nextSeq,
    ts: Date.now(),
  };
  // This route is audit-only: a still-owned pre-rotation execution may finish
  // its durable ordering, but stale lifecycle never reaches public listeners.
  Object.defineProperty(enriched, "lifecycleGeneration", {
    value: lifecycleGeneration,
    enumerable: false,
  });
  const contextLifecycleToken = captureAgentRunEventContextLifecycleToken(
    event.runId,
    lifecycleGeneration,
  );
  if (contextLifecycleToken) {
    captureAgentEventContextLifecycleToken(enriched, contextLifecycleToken);
  }
  return enriched;
}

function claimSyntheticAgentRunContext(
  event: Omit<AgentEventPayload, "seq" | "ts">,
): string | undefined {
  const lifecycleGeneration =
    event.lifecycleGeneration ??
    getAgentRunExecutionLifecycleGeneration() ??
    getAgentRunLifecycleGeneration();
  if (
    event.stream !== "lifecycle" ||
    event.data.phase !== "start" ||
    lifecycleGeneration !== getAgentRunLifecycleGeneration() ||
    getAgentRunContext(event.runId) ||
    hasInvalidLifecycleStartTimestamp(event.stream, event.data)
  ) {
    return undefined;
  }
  const claimId = claimAgentRunContext(
    event.runId,
    {
      agentId: event.agentId,
      lifecycleGeneration,
      sessionId: event.sessionId,
      sessionKey: event.sessionKey,
    },
    { ownsContext: true, trackOwner: true },
  );
  if (!claimId) {
    return undefined;
  }
  const releaseLease = retainActiveAgentRunContext(event.runId, lifecycleGeneration);
  if (!releaseLease) {
    releaseAgentRunContext(event.runId, claimId);
    return undefined;
  }
  const state = getAgentEventState();
  const syntheticRunClaims = (state.syntheticRunClaims ??= new Map());
  const contextLifecycleToken = getAgentRunContextLifecycleToken(event.runId, lifecycleGeneration);
  syntheticRunClaims.set(event.runId, {
    claimId,
    ...(contextLifecycleToken ? { contextLifecycleToken } : {}),
    lifecycleGeneration,
    releaseLease,
  });
  while (syntheticRunClaims.size > MAX_SYNTHETIC_AGENT_RUN_CLAIMS) {
    const oldestRunId = syntheticRunClaims.keys().next().value;
    if (oldestRunId === undefined) {
      break;
    }
    const oldestClaim = syntheticRunClaims.get(oldestRunId);
    if (oldestClaim) {
      releaseSyntheticAgentRunClaim(oldestRunId, oldestClaim.claimId);
    }
  }
  return claimId;
}

function releaseSyntheticAgentRunClaim(runId: string, claimId: string): void {
  const state = getAgentEventState();
  const syntheticRunClaims = state.syntheticRunClaims;
  const syntheticClaim = syntheticRunClaims?.get(runId);
  if (syntheticRunClaims && syntheticClaim?.claimId === claimId) {
    syntheticRunClaims.delete(runId);
    syntheticClaim.releaseLease();
  }
  releaseAgentRunContext(runId, claimId);
}

function releaseSyntheticAgentRunContext(event: AgentEventPayload): void {
  if (
    event.stream !== "lifecycle" ||
    (event.data.phase !== "end" && event.data.phase !== "error")
  ) {
    return;
  }
  const state = getAgentEventState();
  const syntheticClaim = state.syntheticRunClaims?.get(event.runId);
  const contextLifecycleToken = getAgentEventContextLifecycleToken(event);
  if (
    !syntheticClaim ||
    (event.lifecycleGeneration &&
      syntheticClaim.lifecycleGeneration !== event.lifecycleGeneration) ||
    (contextLifecycleToken &&
      syntheticClaim.contextLifecycleToken &&
      contextLifecycleToken !== syntheticClaim.contextLifecycleToken)
  ) {
    return;
  }
  releaseSyntheticAgentRunClaim(event.runId, syntheticClaim.claimId);
}

/** Emits an event only when its run ownership is still current. */
export function emitAgentEventIfCurrent(event: Omit<AgentEventPayload, "seq" | "ts">): boolean {
  const syntheticClaimId = claimSyntheticAgentRunContext(event);
  const enriched = enrichAgentEvent(event);
  if (!enriched) {
    if (syntheticClaimId) {
      releaseSyntheticAgentRunClaim(event.runId, syntheticClaimId);
    }
    return false;
  }
  try {
    notifyListeners(getAgentEventState().listeners, enriched);
  } finally {
    releaseSyntheticAgentRunContext(enriched);
  }
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
  const syntheticClaimId = claimSyntheticAgentRunContext(event);
  const enriched =
    enrichAgentEvent(event, undefined, true) ?? enrichOwnedStaleAgentAuditEvent(event);
  if (enriched) {
    const contextLifecycleToken = getAgentEventContextLifecycleToken(enriched);
    const registeredContextLifecycleToken = enriched.lifecycleGeneration
      ? getAgentRunContextLifecycleToken(event.runId, enriched.lifecycleGeneration)
      : undefined;
    const attribution =
      !contextLifecycleToken ||
      !registeredContextLifecycleToken ||
      contextLifecycleToken === registeredContextLifecycleToken
        ? getAgentRunContext(event.runId)?.attribution
        : undefined;
    const matchingAttribution =
      attribution?.lifecycleGeneration === enriched.lifecycleGeneration ? attribution : undefined;
    const auditEvent = matchingAttribution
      ? {
          ...enriched,
          ...(matchingAttribution.sessionKey ? { sessionKey: matchingAttribution.sessionKey } : {}),
          ...(matchingAttribution.sessionId ? { sessionId: matchingAttribution.sessionId } : {}),
          ...(matchingAttribution.agentId ? { agentId: matchingAttribution.agentId } : {}),
        }
      : enriched;
    if (enriched.lifecycleGeneration) {
      Object.defineProperty(auditEvent, "lifecycleGeneration", {
        value: enriched.lifecycleGeneration,
        enumerable: false,
      });
    }
    if (contextLifecycleToken) {
      captureAgentEventContextLifecycleToken(auditEvent, contextLifecycleToken);
    }
    try {
      notifyListeners(state.auditListeners, auditEvent);
    } finally {
      releaseSyntheticAgentRunContext(enriched);
      const phase = event.stream === "lifecycle" ? event.data.phase : undefined;
      const completesRegisteredContext =
        !contextLifecycleToken ||
        !registeredContextLifecycleToken ||
        contextLifecycleToken === registeredContextLifecycleToken;
      if (
        (phase === "end" || phase === "error") &&
        enriched.lifecycleGeneration &&
        completesRegisteredContext
      ) {
        state.retiredSeqByRunInstance.delete(
          buildAgentRunInstanceKey(event.runId, enriched.lifecycleGeneration),
        );
      }
      if ((phase === "end" || phase === "error") && !getAgentRunContext(event.runId)) {
        // Private synthetic runs bypass public terminal cleanup. Release sequence state only
        // after synchronous audit listeners consume the terminal event and its final ordering.
        state.seqByRun.delete(event.runId);
      }
    }
  } else if (syntheticClaimId) {
    releaseSyntheticAgentRunClaim(event.runId, syntheticClaimId);
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
  state.retiredSeqByRunInstance.clear();
  for (const syntheticClaim of state.syntheticRunClaims?.values() ?? []) {
    syntheticClaim.releaseLease();
  }
  state.syntheticRunClaims?.clear();
  resetAgentRunRegistryForTest();
  if (!options?.preserveListeners) {
    state.listeners.clear();
    state.auditListeners.clear();
  }
}
