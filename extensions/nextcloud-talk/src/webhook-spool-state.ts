// Nextcloud Talk plugin module owns webhook ingress identity and legacy-state migration.
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";

export const NEXTCLOUD_TALK_INGRESS_PAYLOAD_VERSION = 1;

export type NextcloudTalkIngressPayload = {
  version: 1;
  receivedAt: number;
  rawEvent: string;
};

export type NextcloudTalkLegacyReplayEntry = {
  key: string;
  seenAt: number;
};

export type NextcloudTalkLegacyReplayStore = {
  entries: () => Promise<Array<{ value: NextcloudTalkLegacyReplayEntry }>>;
  clear: () => Promise<void>;
};

export class NextcloudTalkWebhookPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NextcloudTalkWebhookPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRawObject(rawEvent: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch (error) {
    throw new NextcloudTalkWebhookPayloadError("Nextcloud Talk webhook contains invalid JSON.", {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new NextcloudTalkWebhookPayloadError("Nextcloud Talk webhook must be a JSON object.");
  }
  return parsed;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new NextcloudTalkWebhookPayloadError(`Nextcloud Talk webhook is missing ${field}.`);
}

export function inspectNextcloudTalkWebhookEnvelope(
  rawEvent: string,
): { eventId: string; laneKey: string } | null {
  const envelope = parseRawObject(rawEvent);
  if (envelope.type !== "Create") {
    return null;
  }
  const object = isRecord(envelope.object) ? envelope.object : null;
  if (object?.type !== undefined && object.type !== "Note") {
    return null;
  }
  if (!object) {
    throw new NextcloudTalkWebhookPayloadError("Nextcloud Talk webhook is missing object.");
  }
  const target = isRecord(envelope.target) ? envelope.target : null;
  return {
    eventId: requiredString(object.id, "object.id"),
    laneKey: `room:${requiredString(target?.id, "target.id")}`,
  };
}

function parseLegacyReplayKey(key: string): { messageId: string; roomId: string } | null {
  const separator = key.lastIndexOf(":");
  const roomId = key.slice(0, separator).trim();
  const messageId = key.slice(separator + 1).trim();
  return separator > 0 && roomId && messageId ? { messageId, roomId } : null;
}

/** Convert the shipped replay guard's live window into durable completion tombstones. */
export async function migrateNextcloudTalkLegacyReplayState(params: {
  queue: ChannelIngressQueue<NextcloudTalkIngressPayload>;
  store: NextcloudTalkLegacyReplayStore;
}): Promise<number> {
  const entries = await params.store.entries();
  let migrated = 0;
  for (const entry of entries) {
    const identity = parseLegacyReplayKey(entry.value.key);
    if (!identity || !Number.isFinite(entry.value.seenAt)) {
      continue;
    }
    const marker: NextcloudTalkIngressPayload = {
      version: NEXTCLOUD_TALK_INGRESS_PAYLOAD_VERSION,
      receivedAt: entry.value.seenAt,
      rawEvent: "",
    };
    const result = await params.queue.enqueue(identity.messageId, marker, {
      receivedAt: entry.value.seenAt,
      laneKey: `room:${identity.roomId}`,
    });
    const ownsMarker =
      result.kind === "accepted" ||
      (result.kind === "pending" && result.record.payload.rawEvent === "");
    if (ownsMarker) {
      const completed = await params.queue.complete(identity.messageId, {
        completedAt: entry.value.seenAt,
      });
      if (!completed) {
        throw new Error(`Failed to migrate Nextcloud Talk replay key ${entry.value.key}.`);
      }
    }
    // Any existing ingress row already rejects the retired guard's duplicate.
    migrated += 1;
  }
  await params.store.clear();
  return migrated;
}
