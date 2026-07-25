// Nostr plugin module owns durable ingress identity and legacy-state migration.
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";

export const NOSTR_INGRESS_PAYLOAD_VERSION = 1;

export type NostrIngressPayload = {
  version: 1;
  receivedAt: number;
  rawEvent: string;
};

export class NostrIngressPermanentError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NostrIngressPermanentError";
    this.reason = reason;
  }
}

export function isNostrIngressRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new NostrIngressPermanentError("invalid-event", `Nostr event is missing ${field}.`);
}

export function inspectNostrIngressEvent(event: unknown): { eventId: string; laneKey: string } {
  if (!isNostrIngressRecord(event)) {
    throw new NostrIngressPermanentError("invalid-event", "Nostr event must be an object.");
  }
  return {
    eventId: requiredString(event.id, "id"),
    laneKey: `direct:${requiredString(event.pubkey, "pubkey")}`,
  };
}

/** Convert the retired persisted LRU seed into durable completion tombstones. */
export async function migrateNostrLegacyRecentEventIds(params: {
  queue: ChannelIngressQueue<NostrIngressPayload>;
  eventIds: readonly string[];
  migratedAt?: number;
}): Promise<number> {
  const migratedAt = params.migratedAt ?? Date.now();
  let migrated = 0;
  for (const eventId of new Set(params.eventIds)) {
    if (!eventId.trim()) {
      continue;
    }
    const result = await params.queue.enqueue(
      eventId,
      { version: NOSTR_INGRESS_PAYLOAD_VERSION, receivedAt: migratedAt, rawEvent: "" },
      { receivedAt: migratedAt, laneKey: `legacy:${eventId}` },
    );
    const ownsMarker =
      result.kind === "accepted" ||
      (result.kind === "pending" && result.record.payload.rawEvent === "");
    if (ownsMarker) {
      const completed = await params.queue.complete(eventId, { completedAt: migratedAt });
      if (!completed) {
        throw new Error(`Failed to migrate Nostr replay event ${eventId}.`);
      }
    }
    // Existing ingress state already rejects the retired LRU's replay.
    migrated += 1;
  }
  return migrated;
}
