// Coordinates queue-media filesystem staging with durable SQLite ownership.
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  deleteDeliveryQueueEntry,
  expireStagingAndLoadDeliveryQueueEntries,
  upsertDeliveryQueueEntry,
  upsertDeliveryQueueEntryInDatabase,
  type DeliveryQueueEntryState,
} from "../delivery-queue-sqlite.js";
import { generateSecureUuid } from "../secure-random.js";

export const LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME = "outbound";
export const OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME = "outbound-legacy-preparing-v1";
export const OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME = "outbound-preparing-v1";
export const OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME = "outbound-prepared-migration-v1";
export const OUTBOUND_DELIVERY_QUEUE_NAME = "outbound-prepared-v1";
export const DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME = "outbound-media-staging";

type MediaStageEntry = DeliveryQueueEntryState & { artifacts: string[] };
type OutboundMediaEntry = DeliveryQueueEntryState & {
  payloads?: ReplyPayload[];
  preparedBatch?: {
    entries?: Array<{ status?: string; payload?: ReplyPayload }>;
  };
};

function entryPayloads(entry: OutboundMediaEntry): ReplyPayload[] {
  if (Array.isArray(entry.payloads)) {
    return entry.payloads;
  }
  return (entry.preparedBatch?.entries ?? []).flatMap((prepared) =>
    prepared.status === "accepted" && prepared.payload ? [prepared.payload] : [],
  );
}

export function createDeliveryQueueMediaRetention(
  artifacts: readonly string[],
  entryKind: "outbound-media-stage" | "outbound-media-recovery-lease",
  stateDir?: string,
  database?: OpenClawStateDatabase,
): string {
  const id = generateSecureUuid();
  const entry: MediaStageEntry = {
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
    artifacts: [...artifacts],
  };
  const insert = {
    queueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
    entry,
    metadata: { entryKind },
    insertOnly: true,
  };
  const inserted = database
    ? upsertDeliveryQueueEntryInDatabase(insert, database)
    : upsertDeliveryQueueEntry({ ...insert, stateDir });
  if (!inserted) {
    throw new Error(`Delivery queue media stage already exists: ${id}`);
  }
  return id;
}

/** Release a stage or recovery lease after its owner settles. */
export function cancelDeliveryQueueMediaRetention(id: string | undefined, stateDir?: string): void {
  if (!id) {
    return;
  }
  deleteDeliveryQueueEntry(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, id, stateDir);
}

/**
 * Atomically expire abandoned stages and return every artifact still owned by
 * either a replayable outbound row or a producer that may still commit one.
 */
export function loadDeliveryQueueMediaRetentionSnapshot(params: {
  expireBeforeMs: number;
  stateDir?: string;
}): { payloads: ReplyPayload[][]; stagedArtifacts: string[] } {
  const snapshot = expireStagingAndLoadDeliveryQueueEntries({
    queueNames: [
      OUTBOUND_DELIVERY_QUEUE_NAME,
      LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
      OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
    ],
    stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
    expireBeforeMs: params.expireBeforeMs,
    stateDir: params.stateDir,
  });
  return {
    payloads: snapshot.entries.map((entry) => entryPayloads(entry as OutboundMediaEntry)),
    stagedArtifacts: snapshot.stagingEntries.flatMap((entry) => {
      const artifacts = (entry as MediaStageEntry).artifacts;
      return Array.isArray(artifacts)
        ? artifacts.filter((artifact): artifact is string => typeof artifact === "string")
        : [];
    }),
  };
}
