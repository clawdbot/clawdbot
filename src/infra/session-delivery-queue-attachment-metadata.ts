import { z } from "zod";

export interface AttachmentRef {
  kind: "blob-sha256";
  sha256: string;
  mediaType?: string;
}

export type QueuedSessionDeliveryPayloadMetadata = {
  traceparent?: string;
  traceparentProvenance?: "internal";
  attachments?: AttachmentRef[];
};

export type QueuedSessionDeliveryCommonMetadata = Omit<
  QueuedSessionDeliveryPayloadMetadata,
  "attachments"
>;

const QueuedAttachmentRefSchema = z.object({
  kind: z.literal("blob-sha256"),
  sha256: z.string().min(1),
  mediaType: z.string().optional(),
});

function hasCanonicalAttachmentRefs(raw: unknown, refs: AttachmentRef[]): boolean {
  if (!Array.isArray(raw) || raw.length !== refs.length) {
    return false;
  }
  return raw.every((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    const ref = refs[index];
    if (!ref) {
      return false;
    }
    const expectedKeys = ref.mediaType === undefined ? 2 : 3;
    return (
      Object.keys(record).length === expectedKeys &&
      record.kind === ref.kind &&
      record.sha256 === ref.sha256 &&
      record.mediaType === ref.mediaType
    );
  });
}

export function normalizeQueuedAttachmentRefs<T extends object>(entry: T): T {
  const raw = (entry as T & { attachments?: unknown }).attachments;
  if (raw === undefined) {
    return entry;
  }
  const parsed = z.array(QueuedAttachmentRefSchema).safeParse(raw);
  const refs = parsed.success ? parsed.data : [];
  if (hasCanonicalAttachmentRefs(raw, refs)) {
    return entry;
  }
  const normalized = { ...entry } as T & { attachments?: AttachmentRef[] };
  if (refs.length > 0) {
    normalized.attachments = refs;
  } else {
    delete normalized.attachments;
  }
  return normalized;
}

export function scrubTerminalQueuedAttachments<T extends { kind: string }>(entry: T): T {
  if (entry.kind !== "postCompactionDelegate") {
    return normalizeQueuedAttachmentRefs(entry);
  }
  return { ...entry, attachments: undefined, attachAs: undefined };
}

export function stripQueuedAttachmentMountWithoutAttachments<
  T extends { attachments?: unknown; attachAs?: unknown },
>(entry: T): T {
  if (entry.attachments) {
    return entry;
  }
  const normalized = { ...entry };
  delete normalized.attachAs;
  return normalized;
}
