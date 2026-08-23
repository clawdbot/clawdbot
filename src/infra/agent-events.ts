// Stores and broadcasts agent lifecycle and streaming events.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { hasInvalidLifecycleStartTimestamp } from "./agent-event-lifecycle.js";
import { createAgentRunStaleLifecycleError } from "./agent-lifecycle-error.js";
import {
  getAgentRunContext,
  getAgentRunContextOwnership,
  getAgentRunLifecycleGeneration,
  registerAgentRunSequenceResetHandler,
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
  listeners: Set<(evt: AgentEventRuntimePayload) => void>;
  auditListeners: Set<(evt: AgentEventPayload) => void>;
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
  }));
}

registerAgentRunSequenceResetHandler((runId) => {
  getAgentEventState().seqByRun.delete(runId);
});

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
    getAgentEventExecutionContext().getStore()?.lifecycleGeneration ??
    getAgentRunContext(runId)?.lifecycleGeneration ??
    getAgentRunLifecycleGeneration()
  );
}

/** Starts a new ownership generation before an in-process gateway restart. */
export function rotateAgentEventLifecycleGeneration(): string {
  const state = getAgentEventState();
  const lifecycleGeneration = rotateAgentRunRegistryLifecycleGeneration();
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
    event.lifecycleGeneration ?? getAgentEventExecutionContext().getStore()?.lifecycleGeneration;
  const ownedLifecycleGeneration = executionLifecycleGeneration ?? context?.lifecycleGeneration;
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
  if (hasInvalidLifecycleStartTimestamp(event.stream, event.data)) {
    return undefined;
  }
  let data = event.data;
  if (context && event.stream === "lifecycle") {
    if (data.phase === "start") {
      context.lifecycleStartedAt = data.startedAt as number;
    } else if (
      (data.phase === "end" || data.phase === "error") &&
      data.startedAt === undefined &&
      context.lifecycleStartedAt !== undefined
    ) {
      // Preserve this run's identity after a newer run takes over its session.
      data = { ...data, startedAt: context.lifecycleStartedAt };
    }
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
      ? (ownedLifecycleGeneration ?? currentLifecycleGeneration)
      : ownedLifecycleGeneration;
  const agentId = event.agentId ?? context?.agentId;
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
  if (context?.isControlUiVisible !== undefined) {
    Object.defineProperty(enriched, "controlUiVisible", {
      value: context.isControlUiVisible,
      enumerable: false,
    });
  }
  if (context?.projectSessionLifecycle !== undefined) {
    Object.defineProperty(enriched, "projectSessionLifecycle", {
      value: context.projectSessionLifecycle,
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
    if ((phase === "end" || phase === "error") && !getAgentRunContext(event.runId)) {
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
  resetAgentRunRegistryForTest();
  if (!options?.preserveListeners) {
    state.listeners.clear();
    state.auditListeners.clear();
  }
}
