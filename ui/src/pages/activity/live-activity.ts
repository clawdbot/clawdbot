import type { EventLogEntry } from "../../api/event-log.ts";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { notifyGatewayObservers } from "../../app/gateway-observers.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";
import { parseActivityEvent, updateToolActivity, type ActivityEntry } from "./tool-activity.ts";

type LiveActivitySnapshot = {
  readonly entries: readonly ActivityEntry[];
  /** Retires page-local expansion and follow state without resetting it on each event. */
  readonly revision: number;
};

export type LiveActivity = {
  readonly snapshot: LiveActivitySnapshot;
  subscribe: (listener: (snapshot: LiveActivitySnapshot) => void) => () => void;
  clear: () => void;
  dispose: () => void;
};

export function createLiveActivity(gateway: ApplicationGateway): LiveActivity {
  let entries: ActivityEntry[] = [];
  let snapshot: LiveActivitySnapshot = { entries, revision: 0 };
  let sessionKey = resolveSessionKey(gateway.snapshot.sessionKey, gateway.snapshot.hello);
  let eventLogRevision = gateway.eventLogRevision;
  let clearBoundary: WeakRef<EventLogEntry> | undefined;
  let disposed = false;
  const listeners = new Set<(snapshot: LiveActivitySnapshot) => void>();

  const publish = (next: ActivityEntry[], reset = false) => {
    if (next === entries && !reset) {
      return;
    }
    entries = next;
    snapshot = { entries, revision: snapshot.revision + (reset ? 1 : 0) };
    notifyGatewayObservers(
      listeners,
      snapshot,
      "activity",
      (current) => !disposed && current === snapshot,
    );
  };

  const reduce = (
    current: ActivityEntry[],
    source: ApplicationGatewaySnapshot,
    eventName: string,
    payload: unknown,
    receivedAt: number,
  ): ActivityEntry[] => {
    if (eventName !== "agent" && eventName !== "session.tool") {
      return current;
    }
    const event = parseActivityEvent(payload, receivedAt);
    if (
      !event ||
      !uiSessionEventMatches(
        { sessionKey, assistantAgentId: source.assistantAgentId, hello: source.hello },
        event.sessionKey,
        event.agentId,
      )
    ) {
      return current;
    }
    return updateToolActivity(current, event);
  };

  const rebuild = (source: ApplicationGatewaySnapshot) => {
    const eventLog = gateway.eventLog;
    const boundary = clearBoundary?.deref();
    const clearIndex = boundary ? eventLog.indexOf(boundary) : -1;
    const visibleEvents = clearIndex < 0 ? eventLog : eventLog.slice(0, clearIndex);
    let next: ActivityEntry[] = [];
    for (const event of visibleEvents.toReversed()) {
      next = reduce(next, source, event.event, event.payload, event.ts);
    }
    publish(next, true);
  };

  const retireChangedContext = () => {
    const revision = gateway.eventLogRevision;
    if (revision === eventLogRevision) {
      return false;
    }
    eventLogRevision = revision;
    clearBoundary = undefined;
    // Log notification precedes event delivery; replay would apply the next event twice.
    publish([], true);
    return true;
  };

  // Raw history is only a seed for a new owner or selected session, never page navigation.
  rebuild(gateway.snapshot);
  const stopGateway = gateway.subscribe((source) => {
    if (disposed) {
      return;
    }
    const nextSessionKey = resolveSessionKey(source.sessionKey, source.hello);
    const sessionChanged = nextSessionKey !== sessionKey;
    sessionKey = nextSessionKey;
    if (!retireChangedContext() && sessionChanged) {
      rebuild(source);
    }
  });
  const stopEventLog = gateway.subscribeEventLog(() => {
    if (!disposed) {
      retireChangedContext();
    }
  });
  const stopEvents = gateway.subscribeEvents((event: GatewayEventFrame) => {
    if (!disposed) {
      publish(reduce(entries, gateway.snapshot, event.event, event.payload, Date.now()));
    }
  });

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      const boundary = gateway.eventLog[0];
      clearBoundary = boundary ? new WeakRef(boundary) : undefined;
      publish([], true);
    },
    dispose() {
      disposed = true;
      stopGateway();
      stopEventLog();
      stopEvents();
      clearBoundary = undefined;
      entries = [];
      snapshot = { entries, revision: snapshot.revision + 1 };
      listeners.clear();
    },
  };
}
