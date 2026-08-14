// Narrow system event enqueue/peek helper surface without the broad infra-runtime barrel.

import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent as enqueueSystemEventInternal } from "../infra/system-events.js";

type RoutedSystemEventOptions = Omit<
  NonNullable<Parameters<typeof enqueueSystemEventInternal>[1]>,
  "sessionKey"
>;
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
  return enqueueSystemEventInternal(
    text,
    withSystemEventOwner(
      sanitizeSystemEventOptions({ ...options, sessionKey: route.sessionKey }),
      route.agentId,
    ),
  );
}

export { resolveMainSessionKeyFromConfig } from "../config/sessions/main-session.runtime.js";
export { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";

function sanitizeSystemEventOptions(
  options: Parameters<typeof enqueueSystemEventInternal>[1],
): NonNullable<Parameters<typeof enqueueSystemEventInternal>[1]> {
  const {
    sessionDeliveryAckId: _ackId,
    sessionDeliveryAckStateDir: _ackStateDir,
    ...rest
  } = options ?? {};
  return { ...rest, trusted: false };
}

/**
 * SDK consumers are untrusted by construction — force `trusted: false` so a
 * plugin cannot attach trusted-only session and delegate-artifact provenance.
 * Trusted internal producers use the direct `infra/system-events` import.
 *
 * Also strip the session-delivery ack fields (`sessionDeliveryAckId` /
 * `sessionDeliveryAckStateDir`): on drain they trigger a blind
 * `deleteDeliveryQueueEntry` at the caller-supplied state dir, so a plugin must
 * never inject them via this boundary. The legitimate ack producer
 * (continuation-return) sets them through the direct `infra/system-events`
 * import, not this SDK re-export.
 */
export function enqueueSystemEvent(
  text: string,
  options: Parameters<typeof enqueueSystemEventInternal>[1],
): boolean {
  return enqueueSystemEventInternal(text, sanitizeSystemEventOptions(options));
}
