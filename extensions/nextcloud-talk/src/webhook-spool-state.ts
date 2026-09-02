// Nextcloud Talk plugin module owns webhook ingress identity and legacy-state migration.
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import type { NextcloudTalkInboundAttachment } from "./types.js";

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

export type ParsedNextcloudTalkFileShare = {
  text: string;
  attachment?: NextcloudTalkInboundAttachment;
  attachmentIssue?: "media_missing_metadata";
};

function parseDeclaredSizeBytes(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseFileAttachment(value: unknown): NextcloudTalkInboundAttachment | undefined {
  if (!isRecord(value) || value.type !== "file") {
    return undefined;
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const mimeType = typeof value.mimetype === "string" ? value.mimetype.trim() : "";
  const shareUrl = typeof value.link === "string" ? value.link.trim() : "";
  const declaredSizeBytes = parseDeclaredSizeBytes(value.size);
  const hideDownload = value["hide-download"];
  if (
    !name ||
    !mimeType ||
    !shareUrl ||
    declaredSizeBytes === undefined ||
    (hideDownload !== "yes" && hideDownload !== "no")
  ) {
    return undefined;
  }
  const fileId = typeof value.id === "string" && value.id.trim() ? value.id.trim() : undefined;
  return {
    ...(fileId ? { fileId } : {}),
    name,
    mimeType,
    declaredSizeBytes,
    shareUrl,
    hideDownload: hideDownload === "yes",
  };
}

/** Recognize Talk's file-bearing message Activity without admitting other system events. */
export function parseNextcloudTalkFileSharedActivity(
  envelope: Record<string, unknown>,
): ParsedNextcloudTalkFileShare | null {
  if (envelope.type !== "Activity") {
    return null;
  }
  const object = isRecord(envelope.object) ? envelope.object : null;
  if (
    object?.type !== "Note" ||
    (object.name !== "file_shared" && object.name !== "message" && object.name !== "")
  ) {
    return null;
  }

  let content: unknown;
  try {
    content = typeof object.content === "string" ? JSON.parse(object.content) : null;
  } catch {
    content = null;
  }
  const contentRecord = isRecord(content) ? content : null;
  const parameters = isRecord(contentRecord?.parameters) ? contentRecord.parameters : null;
  if (!parameters || !Object.hasOwn(parameters, "file")) {
    return null;
  }
  const message = typeof contentRecord?.message === "string" ? contentRecord.message : "";
  const text = message.trim() === "{file}" ? "" : message;
  const attachment = parseFileAttachment(parameters.file);
  return attachment ? { text, attachment } : { text, attachmentIssue: "media_missing_metadata" };
}

export function inspectNextcloudTalkWebhookEnvelope(
  rawEvent: string,
): { eventId: string; laneKey: string } | null {
  const envelope = parseRawObject(rawEvent);
  const isCreateMessage = envelope.type === "Create";
  const isFileShare = parseNextcloudTalkFileSharedActivity(envelope) !== null;
  if (!isCreateMessage && !isFileShare) {
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
