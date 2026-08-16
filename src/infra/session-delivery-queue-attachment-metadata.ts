import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";

interface AttachmentRef {
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
    if (!isRecord(value)) {
      return false;
    }
    const record = value;
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
  const raw = isRecord(entry) ? entry.attachments : undefined;
  if (raw === undefined) {
    return entry;
  }
  const parsed = z.array(QueuedAttachmentRefSchema).safeParse(raw);
  const refs = parsed.success ? parsed.data : [];
  if (hasCanonicalAttachmentRefs(raw, refs)) {
    return entry;
  }
  // SAFETY: entry is a plain queue-payload object; the shallow copy augmented here retains T's other own keys.
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

function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (!isRecord(value)) {
    return false;
  }
  const record = value;
  if (
    record.kind !== "blob-sha256" ||
    typeof record.sha256 !== "string" ||
    record.sha256.length === 0 ||
    (record.mediaType !== undefined && typeof record.mediaType !== "string")
  ) {
    return false;
  }
  // AttachmentRef is intentionally a descriptor-only contract. Reject unknown
  // keys as well as `content`, so a legacy inline snapshot cannot be carried in
  // a generic event under a nested or extension field.
  return Object.keys(record).every(
    (key) => key === "kind" || key === "sha256" || key === "mediaType",
  );
}

export function hasOnlyGenericAttachmentRefs(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  const record = entry;
  if (Object.hasOwn(record, "attachAs")) {
    return false;
  }
  if (!Object.hasOwn(record, "attachments")) {
    return true;
  }
  return Array.isArray(record.attachments) && record.attachments.every(isAttachmentRef);
}
