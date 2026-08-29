// Line plugin module converts pre-drain spool rows to the canonical queue contract.
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  errorText,
  eventIdFor,
  laneKeyFor,
  legacyEventIdFor,
  LINE_WEBHOOK_SPOOL_INVALID_EVENT_REASON,
  LINE_WEBHOOK_SPOOL_INVALID_PAYLOAD_MESSAGE,
  LINE_WEBHOOK_SPOOL_VERSION,
  LineWebhookPayloadError,
  type LineWebhookSpoolPayload,
} from "./webhook-spool-contract.js";

/** Pre-drain (#109655) rows stored the event object under `event` instead of the
 *  canonical serialized `rawEvent`; anything else is not a migratable row. */
function parseLegacySpoolPayload(payload: unknown): { destination: string; event: unknown } | null {
  if (!isRecord(payload) || "rawEvent" in payload) {
    return null;
  }
  if (typeof payload.destination !== "string") {
    return null;
  }
  if (!isRecord(payload.event)) {
    return null;
  }
  return { destination: payload.destination, event: payload.event };
}

type LineLegacySpoolMigrationResult = {
  migrated: number;
  /** Rows whose canonical id was already terminal, so no delivery is owed. */
  reconciled: number;
  deadLettered: number;
  recovered: number;
  failures: string[];
};

/** A dead-letter carries the pre-fix decoder's signature when the canonical spool
 *  rejected a pre-drain row before this migration existed. The identity fence and
 *  ordinary delivery failures write different reasons or messages, so neither is
 *  ever treated as recoverable. */
function isLegacyDecodeDeadLetter(row: {
  payload?: unknown;
  reason: string;
  message?: string;
}): boolean {
  return (
    row.reason === LINE_WEBHOOK_SPOOL_INVALID_EVENT_REASON &&
    row.message === LINE_WEBHOOK_SPOOL_INVALID_PAYLOAD_MESSAGE &&
    parseLegacySpoolPayload(row.payload) !== null
  );
}

/** Detection reads rows without owning them, so it takes the inspection projection
 *  rather than a queue it could write through. */
type LineSpoolInspectionQueue = Pick<
  ChannelIngressQueue<LineWebhookSpoolPayload>,
  "listPending" | "listClaims" | "listFailed"
>;

/** Counts pre-drain rows (pending, still claimed, or decoder-dead-lettered)
 *  without mutating anything. */
export async function countLegacySpoolRows(queue: LineSpoolInspectionQueue): Promise<number> {
  const pending = await queue.listPending({ limit: "all" });
  const claims = await queue.listClaims();
  const failed = (await queue.listFailed?.({ limit: "all" })) ?? [];
  return (
    pending.filter((record) => parseLegacySpoolPayload(record.payload) !== null).length +
    claims.filter((claim) => parseLegacySpoolPayload(claim.payload) !== null).length +
    failed.filter((row) => isLegacyDecodeDeadLetter(row)).length
  );
}

/** One-time upgrade migration: rewrite pre-drain (#109655) rows into the canonical
 *  payload and message:/event: keyspace before the spool drains, so the runtime
 *  reader keeps a single row contract. Idempotent — enqueue deduplicates by id, so
 *  a rerun after a crash only re-completes the leftover legacy rows. */
export async function migrateLineLegacySpoolRows(
  queue: ChannelIngressQueue<LineWebhookSpoolPayload>,
): Promise<LineLegacySpoolMigrationResult> {
  const result: LineLegacySpoolMigrationResult = {
    migrated: 0,
    reconciled: 0,
    deadLettered: 0,
    recovered: 0,
    failures: [],
  };
  // Only a retired pre-drain build can hold a claim on a legacy-shaped row. Recover it
  // now instead of leaving it to dead-letter once the canonical decoder claims it; if
  // that build is somehow still delivering, the redelivery falls inside the same
  // at-least-once window the spool's stop path already accepts.
  await queue.recoverStaleClaims({
    staleMs: 0,
    shouldRecover: (claim) => parseLegacySpoolPayload(claim.payload) !== null,
  });
  // A deployment that upgraded before this migration existed already dead-lettered
  // its pre-drain rows at the canonical decoder. Resubmit exactly that signature —
  // with the original receivedAt, preserving drain order — so the pending sweep
  // below re-verifies each row through the same identity fence.
  const failed = (await queue.listFailed?.({ limit: "all" })) ?? [];
  for (const row of failed) {
    if (!isLegacyDecodeDeadLetter(row)) {
      continue;
    }
    try {
      const resubmitted = await queue.resubmit?.(row.id, { resubmittedAt: row.receivedAt });
      if (resubmitted?.kind === "resubmitted") {
        result.recovered += 1;
      }
    } catch (error) {
      result.failures.push(`row ${row.id}: ${errorText(error)}`);
    }
  }
  const pending = await queue.listPending({ limit: "all", orderBy: "received" });
  for (const record of pending) {
    const legacy = parseLegacySpoolPayload(record.payload);
    if (!legacy) {
      continue;
    }
    let eventId: string;
    try {
      if (record.id !== legacyEventIdFor(legacy.event)) {
        throw new LineWebhookPayloadError(
          "LINE webhook event identity changed after durable admission.",
        );
      }
      eventId = eventIdFor(legacy.event);
    } catch (error) {
      await queue.fail(record.id, {
        reason: LINE_WEBHOOK_SPOOL_INVALID_EVENT_REASON,
        message: errorText(error),
      });
      result.deadLettered += 1;
      continue;
    }
    try {
      const admitted = await queue.enqueue(
        eventId,
        {
          version: LINE_WEBHOOK_SPOOL_VERSION,
          rawEvent: JSON.stringify(legacy.event),
          destination: legacy.destination,
        },
        // The original receivedAt keeps migrated rows ordered ahead of rows admitted
        // after the upgrade; completing the legacy id leaves a tombstone that blocks
        // a re-admission of the retired keyspace.
        { receivedAt: record.receivedAt, laneKey: laneKeyFor(legacy.event, eventId) },
      );
      await queue.complete(record.id);
      // A canonical id that is already completed or dead-lettered owes no delivery,
      // so retiring the legacy row reconciles the keyspace rather than migrating a
      // message. Counting it as migrated would report a delivery that never happens.
      if (admitted.kind === "completed" || admitted.kind === "failed") {
        result.reconciled += 1;
      } else {
        result.migrated += 1;
      }
    } catch (error) {
      // One failed rewrite must not abandon the remaining rows; the leftover row
      // stays pending and the idempotent migration retries it on the next run.
      result.failures.push(`row ${record.id}: ${errorText(error)}`);
    }
  }
  return result;
}
