import type { AgentPlanStep } from "../channels/streaming.js";
// Gateway chat run state registries.
// Tracks active runs, delta buffers, tool recipients, and session subscribers.
import type { AgentEventPayload } from "../infra/agent-events.js";

export type ChatRunTiming = {
  ackedAtMs: number;
  connId: string;
  dispatchStartedAtMs?: number;
  firstAssistantEventSent?: boolean;
  receivedAtMs: number;
};

export type ChatRunRegistration = {
  sessionKey: string;
  agentId?: string;
  clientRunId: string;
  chatSendTiming?: ChatRunTiming;
};

export type ChatRunEntry = ChatRunRegistration & {
  registeredAtMs: number;
  registeredSequence: number;
};

export type ChatAbortMarker = number | { abortedAtMs: number; sequence: number };

let chatRunOrderingSequence = 0;

function nextChatRunOrderingSequence(): number {
  chatRunOrderingSequence += 1;
  return chatRunOrderingSequence;
}

/** Stamp a chat run registration with the process-local ordering metadata used for abort freshness checks. */
export function createChatRunEntry(entry: ChatRunRegistration): ChatRunEntry {
  return {
    ...entry,
    registeredAtMs: Date.now(),
    registeredSequence: nextChatRunOrderingSequence(),
  };
}

/** Create an abort marker ordered against chat run registrations, using a shared monotonic sequence. */
export function createChatAbortMarker(now = Date.now()): ChatAbortMarker {
  return { abortedAtMs: now, sequence: nextChatRunOrderingSequence() };
}

/** Return the wall-clock timestamp used by maintenance TTL pruning for both legacy and structured markers. */
export function chatAbortMarkerTimestampMs(marker: ChatAbortMarker): number {
  return typeof marker === "number" ? marker : marker.abortedAtMs;
}

/**
 * Return whether an abort marker should suppress events for the given chat run registration.
 * Structured markers compare the monotonic sequence first so same-millisecond aborts stay ordered;
 * legacy numeric markers fall back to timestamp comparison, and a missing entry preserves old suppress-on-presence behavior.
 */
export function isChatAbortMarkerCurrent(
  marker: ChatAbortMarker | undefined,
  entry?: Pick<ChatRunEntry, "registeredAtMs" | "registeredSequence">,
): boolean {
  if (marker === undefined) {
    return false;
  }
  if (!entry) {
    return true;
  }
  if (typeof marker !== "number" && typeof entry.registeredSequence === "number") {
    return marker.sequence >= entry.registeredSequence;
  }
  if (typeof entry.registeredAtMs !== "number") {
    return true;
  }
  const abortedAtMs = typeof marker === "number" ? marker : marker.abortedAtMs;
  return abortedAtMs >= entry.registeredAtMs;
}

export type BufferedAgentEvent = {
  sessionKey?: string;
  agentId?: string;
  payload: AgentEventPayload & { spawnedBy?: string };
};

export type ChatRunPlanSnapshot = {
  steps: AgentPlanStep[];
  explanation?: string;
};

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunRegistration) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};

/** Create the FIFO registry that maps session IDs to active chat runs. */
export function createChatRunRegistry(): ChatRunRegistry {
  const chatRunSessions = new Map<string, ChatRunEntry[]>();

  const add = (sessionId: string, entry: ChatRunRegistration) => {
    const registeredEntry = createChatRunEntry(entry);
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(registeredEntry);
    } else {
      chatRunSessions.set(sessionId, [registeredEntry]);
    }
  };

  const peek = (sessionId: string) => chatRunSessions.get(sessionId)?.[0];

  const shift = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const entry = queue.shift();
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) {
      return undefined;
    }
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const clear = () => {
    chatRunSessions.clear();
  };

  return { add, peek, shift, remove, clear };
}

export type ChatRunState = {
  registry: ChatRunRegistry;
  rawBuffers: Map<string, string>;
  buffers: Map<string, string>;
  planSnapshots: Map<string, ChatRunPlanSnapshot>;
  /** Last time any buffered assistant text changed, including suppressed raw buffers. */
  bufferUpdatedAt: Map<string, number>;
  deltaSentAt: Map<string, number>;
  /** Length of text at the time of the last broadcast, used to avoid duplicate flushes. */
  deltaLastBroadcastLen: Map<string, number>;
  deltaLastBroadcastText: Map<string, string>;
  agentDeltaSentAt: Map<string, number>;
  bufferedAgentEvents: Map<string, BufferedAgentEvent>;
  abortedRuns: Map<string, ChatAbortMarker>;
  clearRun: (runId: string) => void;
  clear: () => void;
};

/** Create all mutable chat-run maps used by Gateway runtime state. */
export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const rawBuffers = new Map<string, string>();
  const buffers = new Map<string, string>();
  const planSnapshots = new Map<string, ChatRunPlanSnapshot>();
  const bufferUpdatedAt = new Map<string, number>();
  const deltaSentAt = new Map<string, number>();
  const deltaLastBroadcastLen = new Map<string, number>();
  const deltaLastBroadcastText = new Map<string, string>();
  const agentDeltaSentAt = new Map<string, number>();
  const bufferedAgentEvents = new Map<string, BufferedAgentEvent>();
  const abortedRuns = new Map<string, ChatAbortMarker>();

  const clearRun = (runId: string) => {
    rawBuffers.delete(runId);
    buffers.delete(runId);
    planSnapshots.delete(runId);
    bufferUpdatedAt.delete(runId);
    deltaSentAt.delete(runId);
    deltaLastBroadcastLen.delete(runId);
    deltaLastBroadcastText.delete(runId);
    for (const key of [runId, `${runId}:assistant`, `${runId}:thinking`]) {
      agentDeltaSentAt.delete(key);
      bufferedAgentEvents.delete(key);
    }
  };

  const clear = () => {
    registry.clear();
    rawBuffers.clear();
    buffers.clear();
    planSnapshots.clear();
    bufferUpdatedAt.clear();
    deltaSentAt.clear();
    deltaLastBroadcastLen.clear();
    deltaLastBroadcastText.clear();
    agentDeltaSentAt.clear();
    bufferedAgentEvents.clear();
    abortedRuns.clear();
  };

  return {
    registry,
    rawBuffers,
    buffers,
    planSnapshots,
    bufferUpdatedAt,
    deltaSentAt,
    deltaLastBroadcastLen,
    deltaLastBroadcastText,
    agentDeltaSentAt,
    bufferedAgentEvents,
    abortedRuns,
    clearRun,
    clear,
  };
}

export type ToolEventRecipientRegistry = {
  add: (runId: string, connId: string) => void;
  get: (runId: string) => ReadonlySet<string> | undefined;
  markFinal: (runId: string) => void;
};

export type SessionEventSubscriberRegistry = {
  subscribe: (connId: string) => void;
  unsubscribe: (connId: string) => void;
  getAll: () => ReadonlySet<string>;
  clear: () => void;
};

export type SessionMessageSubscriberRegistry = {
  subscribe: (
    connId: string,
    sessionKey: string,
    opts?: { includeApprovals?: boolean; provisional?: boolean },
  ) => SessionMessageSubscription | undefined;
  unsubscribe: (connId: string, sessionKey: string) => void;
  unsubscribeAll: (connId: string) => void;
  get: (sessionKey: string) => ReadonlySet<string>;
  getForConnection: (connId: string) => ReadonlySet<string>;
  getApprovals: (sessionKey: string) => ReadonlySet<string>;
  onChange: (listener: (sessionKey: string) => void) => () => void;
  clear: () => void;
};

type SessionMessageSubscription = (() => void) & { commit: () => void };

type ProvisionalSubscriptionState = {
  active: boolean;
  base: number | undefined;
  baseApprovals: boolean;
  inflight: number;
  lastSuccess: number | undefined;
  lastSuccessApprovals: boolean | undefined;
};

type ToolRecipientEntry = {
  connIds: Set<string>;
  updatedAt: number;
  finalizedAt?: number;
};

const TOOL_EVENT_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1000;

/** Create the broad sessions.changed subscriber registry. */
export function createSessionEventSubscriberRegistry(): SessionEventSubscriberRegistry {
  const connIds = new Set<string>();
  const empty = new Set<string>();

  return {
    subscribe: (connId: string) => {
      const normalized = connId.trim();
      if (!normalized) {
        return;
      }
      connIds.add(normalized);
    },
    unsubscribe: (connId: string) => {
      const normalized = connId.trim();
      if (!normalized) {
        return;
      }
      connIds.delete(normalized);
    },
    getAll: () => (connIds.size > 0 ? connIds : empty),
    clear: () => {
      connIds.clear();
    },
  };
}

/** Create the per-session message subscriber registry. */
export function createSessionMessageSubscriberRegistry(): SessionMessageSubscriberRegistry {
  const sessionToConnIds = new Map<string, Set<string>>();
  const connToSessionKeys = new Map<string, Set<string>>();
  // The final state after overlapping replays settles to their latest success
  // or the original committed base; failed provisionals cannot leave ghosts.
  const connToSessionRecency = new Map<string, Map<string, number>>();
  const provisionalSubscriptions = new Map<string, Map<string, ProvisionalSubscriptionState>>();
  const approvalSessionToConnIds = new Map<string, Set<string>>();
  const connToApprovalSessionKeys = new Map<string, Set<string>>();
  const changeListeners = new Set<(sessionKey: string) => void>();
  const empty = new Set<string>();
  let subscriptionSequence = 0;

  const normalize = (value: string): string => value.trim();
  const rebuildConnectionSessionKeys = (connId: string) => {
    const recency = connToSessionRecency.get(connId);
    if (!recency || recency.size === 0) {
      connToSessionKeys.delete(connId);
      return;
    }
    connToSessionKeys.set(
      connId,
      new Set([...recency.entries()].toSorted(([, a], [, b]) => a - b).map(([key]) => key)),
    );
  };
  const setMessageSubscription = (connId: string, sessionKey: string, subscribed: boolean) => {
    const connIds = sessionToConnIds.get(sessionKey);
    const wasSubscribed = connIds?.has(connId) === true;
    if (subscribed) {
      const nextConnIds = connIds ?? new Set<string>();
      nextConnIds.add(connId);
      sessionToConnIds.set(sessionKey, nextConnIds);
      if (!wasSubscribed) {
        for (const listener of changeListeners) {
          listener(sessionKey);
        }
      }
      return;
    }
    connIds?.delete(connId);
    if (connIds?.size === 0) {
      sessionToConnIds.delete(sessionKey);
    }
    if (wasSubscribed) {
      for (const listener of changeListeners) {
        listener(sessionKey);
      }
    }
  };
  const setApprovalSubscription = (connId: string, sessionKey: string, subscribed: boolean) => {
    const connIds = approvalSessionToConnIds.get(sessionKey);
    const sessionKeys = connToApprovalSessionKeys.get(connId);
    if (subscribed) {
      const nextConnIds = connIds ?? new Set<string>();
      nextConnIds.add(connId);
      approvalSessionToConnIds.set(sessionKey, nextConnIds);
      const nextSessionKeys = sessionKeys ?? new Set<string>();
      nextSessionKeys.add(sessionKey);
      connToApprovalSessionKeys.set(connId, nextSessionKeys);
      return;
    }
    connIds?.delete(connId);
    if (connIds?.size === 0) {
      approvalSessionToConnIds.delete(sessionKey);
    }
    sessionKeys?.delete(sessionKey);
    if (sessionKeys?.size === 0) {
      connToApprovalSessionKeys.delete(connId);
    }
  };

  const registry: SessionMessageSubscriberRegistry = {
    subscribe: (connId: string, sessionKey: string, opts) => {
      const normalizedConnId = normalize(connId);
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedConnId || !normalizedSessionKey) {
        return undefined;
      }
      const hadApprovals =
        approvalSessionToConnIds.get(normalizedSessionKey)?.has(normalizedConnId) ?? false;
      const recency = connToSessionRecency.get(normalizedConnId) ?? new Map<string, number>();
      const previousRecency = recency.get(normalizedSessionKey);
      const states = provisionalSubscriptions.get(normalizedConnId) ?? new Map();
      const state = states.get(normalizedSessionKey) ?? {
        base: previousRecency,
        baseApprovals: hadApprovals,
        active: true,
        inflight: 0,
        lastSuccess: undefined,
        lastSuccessApprovals: undefined,
      };
      state.inflight += 1;
      states.set(normalizedSessionKey, state);
      provisionalSubscriptions.set(normalizedConnId, states);
      subscriptionSequence += 1;
      const provisionalRecency = subscriptionSequence;
      setMessageSubscription(normalizedConnId, normalizedSessionKey, true);
      recency.set(normalizedSessionKey, provisionalRecency);
      connToSessionRecency.set(normalizedConnId, recency);
      rebuildConnectionSessionKeys(normalizedConnId);

      setApprovalSubscription(
        normalizedConnId,
        normalizedSessionKey,
        opts?.includeApprovals === true,
      );
      let settled = false;
      const settle = (succeeded: boolean) => {
        if (settled || !state.active) {
          return;
        }
        settled = true;
        if (succeeded) {
          if (provisionalRecency >= (state.lastSuccess ?? -Infinity)) {
            state.lastSuccess = provisionalRecency;
            state.lastSuccessApprovals = opts?.includeApprovals === true;
          }
        }
        state.inflight -= 1;
        if (state.inflight > 0) {
          return;
        }
        const committedRecency = state.lastSuccess ?? state.base;
        if (committedRecency === undefined) {
          recency.delete(normalizedSessionKey);
          setMessageSubscription(normalizedConnId, normalizedSessionKey, false);
          setApprovalSubscription(normalizedConnId, normalizedSessionKey, false);
        } else {
          recency.set(normalizedSessionKey, committedRecency);
          setMessageSubscription(normalizedConnId, normalizedSessionKey, true);
          setApprovalSubscription(
            normalizedConnId,
            normalizedSessionKey,
            state.lastSuccessApprovals ?? state.baseApprovals,
          );
        }
        if (recency.size === 0) {
          connToSessionRecency.delete(normalizedConnId);
        }
        rebuildConnectionSessionKeys(normalizedConnId);
        states.delete(normalizedSessionKey);
        if (states.size === 0) {
          provisionalSubscriptions.delete(normalizedConnId);
        }
      };
      const rollback = (() => settle(false)) as SessionMessageSubscription;
      rollback.commit = () => settle(true);
      if (!opts?.provisional) {
        rollback.commit();
        return undefined;
      }
      return rollback;
    },
    unsubscribe: (connId: string, sessionKey: string) => {
      const normalizedConnId = normalize(connId);
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedConnId || !normalizedSessionKey) {
        return;
      }
      const states = provisionalSubscriptions.get(normalizedConnId);
      const state = states?.get(normalizedSessionKey);
      if (state) {
        state.active = false;
        states?.delete(normalizedSessionKey);
        if (states?.size === 0) {
          provisionalSubscriptions.delete(normalizedConnId);
        }
      }
      setMessageSubscription(normalizedConnId, normalizedSessionKey, false);
      const recency = connToSessionRecency.get(normalizedConnId);
      if (recency) {
        recency.delete(normalizedSessionKey);
        if (recency.size === 0) {
          connToSessionRecency.delete(normalizedConnId);
        }
        rebuildConnectionSessionKeys(normalizedConnId);
      }
      const approvalConnIds = approvalSessionToConnIds.get(normalizedSessionKey);
      if (approvalConnIds) {
        approvalConnIds.delete(normalizedConnId);
        if (approvalConnIds.size === 0) {
          approvalSessionToConnIds.delete(normalizedSessionKey);
        }
      }
      const approvalSessionKeys = connToApprovalSessionKeys.get(normalizedConnId);
      if (approvalSessionKeys) {
        approvalSessionKeys.delete(normalizedSessionKey);
        if (approvalSessionKeys.size === 0) {
          connToApprovalSessionKeys.delete(normalizedConnId);
        }
      }
    },
    unsubscribeAll: (connId: string) => {
      const normalizedConnId = normalize(connId);
      if (!normalizedConnId) {
        return;
      }
      const states = provisionalSubscriptions.get(normalizedConnId);
      for (const state of states?.values() ?? []) {
        state.active = false;
      }
      provisionalSubscriptions.delete(normalizedConnId);
      const sessionKeys = connToSessionKeys.get(normalizedConnId);
      if (!sessionKeys) {
        return;
      }
      for (const sessionKey of sessionKeys) {
        setMessageSubscription(normalizedConnId, sessionKey, false);
      }
      connToSessionKeys.delete(normalizedConnId);
      connToSessionRecency.delete(normalizedConnId);

      const approvalSessionKeys = connToApprovalSessionKeys.get(normalizedConnId);
      for (const sessionKey of approvalSessionKeys ?? []) {
        const connIds = approvalSessionToConnIds.get(sessionKey);
        connIds?.delete(normalizedConnId);
        if (connIds?.size === 0) {
          approvalSessionToConnIds.delete(sessionKey);
        }
      }
      connToApprovalSessionKeys.delete(normalizedConnId);
    },
    get: (sessionKey: string) => {
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedSessionKey) {
        return empty;
      }
      return sessionToConnIds.get(normalizedSessionKey) ?? empty;
    },
    getForConnection: (connId: string) => {
      const normalizedConnId = normalize(connId);
      if (!normalizedConnId) {
        return empty;
      }
      return connToSessionKeys.get(normalizedConnId) ?? empty;
    },
    getApprovals: (sessionKey: string) => {
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedSessionKey) {
        return empty;
      }
      return approvalSessionToConnIds.get(normalizedSessionKey) ?? empty;
    },
    onChange: (listener) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    clear: () => {
      const changedSessionKeys = [...sessionToConnIds.keys()].toSorted();
      sessionToConnIds.clear();
      connToSessionKeys.clear();
      connToSessionRecency.clear();
      for (const states of provisionalSubscriptions.values()) {
        for (const state of states.values()) {
          state.active = false;
        }
      }
      provisionalSubscriptions.clear();
      approvalSessionToConnIds.clear();
      connToApprovalSessionKeys.clear();
      for (const sessionKey of changedSessionKeys) {
        for (const listener of changeListeners) {
          listener(sessionKey);
        }
      }
    },
  };
  return registry;
}

/** Create the run-id recipient registry used for streaming tool events. */
export function createToolEventRecipientRegistry(): ToolEventRecipientRegistry {
  const recipients = new Map<string, ToolRecipientEntry>();

  const prune = () => {
    if (recipients.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [runId, entry] of recipients) {
      const cutoff = entry.finalizedAt
        ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS;
      if (now >= cutoff) {
        recipients.delete(runId);
      }
    }
  };

  const add = (runId: string, connId: string) => {
    if (!runId || !connId) {
      return;
    }
    const now = Date.now();
    const existing = recipients.get(runId);
    if (existing) {
      existing.connIds.add(connId);
      existing.updatedAt = now;
    } else {
      recipients.set(runId, {
        connIds: new Set([connId]),
        updatedAt: now,
      });
    }
    prune();
  };

  const get = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return undefined;
    }
    entry.updatedAt = Date.now();
    prune();
    return entry.connIds;
  };

  const markFinal = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return;
    }
    entry.finalizedAt = Date.now();
    prune();
  };

  return { add, get, markFinal };
}
