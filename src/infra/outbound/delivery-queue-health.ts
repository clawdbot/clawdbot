// Builds a bounded, metadata-only health projection for outbound dead letters.
import { countFailedDeliveryQueueEntriesByMetadata } from "../delivery-queue-sqlite.js";
import {
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";

const MAX_BREAKDOWN_GROUPS = 50;
const MAX_CHANNEL_LENGTH = 64;
const MISSING_CHANNEL = "[missing]";
const OTHER_CHANNEL = "[other]";

export type OutboundDeliveryQueueCategory =
  | "prepared"
  | "preparation"
  | "migration"
  | "legacy"
  | "mediaStaging";

export type OutboundDeliveryRecoveryCategory =
  | "none"
  | "producerClaimed"
  | "sendAttemptStarted"
  | "unknownAfterSend"
  | "other";

export type OutboundDeadLetterHealthBucket = {
  queue: OutboundDeliveryQueueCategory;
  channel: string;
  recoveryState: OutboundDeliveryRecoveryCategory;
  count: number;
  oldestFailedAt?: number;
  newestFailedAt?: number;
};

export type OutboundDeadLetterHealthSummary = {
  count: number;
  oldestFailedAt?: number;
  newestFailedAt?: number;
  buckets: OutboundDeadLetterHealthBucket[];
};

const queueCategoryByName = new Map<string, OutboundDeliveryQueueCategory>([
  [OUTBOUND_DELIVERY_QUEUE_NAME, "prepared"],
  [OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME, "preparation"],
  [OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, "preparation"],
  [OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, "migration"],
  [LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, "legacy"],
  [DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, "mediaStaging"],
]);

const outboundQueueNames = [...queueCategoryByName.keys()];

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint != null && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function normalizeChannel(channel: string | null): string {
  if (!channel) {
    return MISSING_CHANNEL;
  }
  if (channel.length > MAX_CHANNEL_LENGTH || containsControlCharacter(channel)) {
    return OTHER_CHANNEL;
  }
  return channel;
}

function recoveryCategory(recoveryState: string | null): OutboundDeliveryRecoveryCategory {
  switch (recoveryState) {
    case null:
    case "":
      return "none";
    case "producer_claimed":
      return "producerClaimed";
    case "send_attempt_started":
      return "sendAttemptStarted";
    case "unknown_after_send":
      return "unknownAfterSend";
    default:
      return "other";
  }
}

function includeFailureTime(
  target: { oldestFailedAt?: number; newestFailedAt?: number },
  oldestFailedAt: number | null,
  newestFailedAt: number | null,
): void {
  if (oldestFailedAt != null) {
    target.oldestFailedAt = Math.min(target.oldestFailedAt ?? oldestFailedAt, oldestFailedAt);
  }
  if (newestFailedAt != null) {
    target.newestFailedAt = Math.max(target.newestFailedAt ?? newestFailedAt, newestFailedAt);
  }
}

/** Returns no value when there are no outbound dead letters. */
export function summarizeOutboundFailedDeliveryQueueEntries(
  stateDir?: string,
): OutboundDeadLetterHealthSummary | undefined {
  const breakdown = countFailedDeliveryQueueEntriesByMetadata({
    queueNames: outboundQueueNames,
    maxGroups: MAX_BREAKDOWN_GROUPS,
    stateDir,
  });
  if (breakdown.truncated) {
    throw new Error("outbound dead-letter health breakdown exceeded its fixed group bound");
  }
  if (breakdown.groups.length === 0) {
    return undefined;
  }

  const summary: OutboundDeadLetterHealthSummary = { count: 0, buckets: [] };
  const buckets = new Map<string, OutboundDeadLetterHealthBucket>();
  for (const group of breakdown.groups) {
    const queue = queueCategoryByName.get(group.queueName);
    if (!queue) {
      continue;
    }
    const channel = normalizeChannel(group.channel);
    const recoveryState = recoveryCategory(group.recoveryState);
    const key = JSON.stringify([queue, channel, recoveryState]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { queue, channel, recoveryState, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += group.count;
    includeFailureTime(bucket, group.oldestFailedAt, group.newestFailedAt);
    summary.count += group.count;
    includeFailureTime(summary, group.oldestFailedAt, group.newestFailedAt);
  }
  summary.buckets = [...buckets.values()].toSorted(
    (left, right) =>
      left.queue.localeCompare(right.queue) ||
      left.channel.localeCompare(right.channel) ||
      left.recoveryState.localeCompare(right.recoveryState),
  );
  return summary.count > 0 ? summary : undefined;
}
