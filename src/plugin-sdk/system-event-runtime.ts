// Narrow system event enqueue/peek helper surface without the broad infra-runtime barrel.

import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../infra/system-events.js";

type RoutedSystemEventOptions = Omit<Parameters<typeof enqueueSystemEvent>[1], "sessionKey">;
type RoutedSystemEventRoute = { agentId: string; sessionKey: string };

export function enqueueRoutedSystemEvent(
  text: string,
  route: RoutedSystemEventRoute,
  options: RoutedSystemEventOptions = {},
): boolean {
  if (!route.agentId.trim()) {
    throw new Error("routed system events require route.agentId");
  }
  // Literal global keys carry no owner identity, so bind the resolved route owner
  // before enqueueing into the shared transient queue.
  return enqueueSystemEvent(
    text,
    withSystemEventOwner({ ...options, sessionKey: route.sessionKey }, route.agentId),
  );
}

export {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
export { resolveMainSessionKeyFromConfig } from "../config/sessions/main-session.runtime.js";
