// System event queue helpers without the broad infra-runtime barrel.

import { enqueueSystemEvent as enqueueSystemEventInternal } from "../infra/system-events.js";

export { resolveMainSessionKeyFromConfig } from "../config/sessions/main-session.runtime.js";
export { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";

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
  const {
    sessionDeliveryAckId: _ackId,
    sessionDeliveryAckStateDir: _ackStateDir,
    ...rest
  } = options ?? {};
  return enqueueSystemEventInternal(text, { ...rest, trusted: false });
}
