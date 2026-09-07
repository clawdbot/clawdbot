import type { GatewayEventFrame } from "../../api/gateway.ts";
import { notifyGatewayObservers } from "../../app/gateway-observers.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
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
  let eventLogRevision = gateway.eventLogRevision;
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
    eventName: string,
    payload: unknown,
    receivedAt: number,
  ): ActivityEntry[] => {
    if (eventName !== "agent" && eventName !== "session.tool") {
      return current;
    }
    const event = parseActivityEvent(payload, receivedAt);
    if (!event) {
      return current;
    }
    return updateToolActivity(current, event);
  };

  const retireChangedContext = () => {
    const revision = gateway.eventLogRevision;
    if (revision === eventLogRevision) {
      return false;
    }
    eventLogRevision = revision;
    // Log notification precedes event delivery; replay would apply the next event twice.
    publish([], true);
    return true;
  };

  // Gateway delivery owns visibility; Activity is independent of the selected chat.
  let initialEntries: ActivityEntry[] = [];
  for (const event of gateway.eventLog.toReversed()) {
    initialEntries = reduce(initialEntries, event.event, event.payload, event.ts);
  }
  publish(initialEntries, true);
  const stopGateway = gateway.subscribe(() => {
    if (!disposed) {
      retireChangedContext();
    }
  });
  const stopEventLog = gateway.subscribeEventLog(() => {
    if (!disposed) {
      retireChangedContext();
    }
  });
  const stopEvents = gateway.subscribeEvents((event: GatewayEventFrame) => {
    if (!disposed) {
      publish(reduce(entries, event.event, event.payload, Date.now()));
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
      publish([], true);
    },
    dispose() {
      disposed = true;
      stopGateway();
      stopEventLog();
      stopEvents();
      entries = [];
      snapshot = { entries, revision: snapshot.revision + 1 };
      listeners.clear();
    },
  };
}
