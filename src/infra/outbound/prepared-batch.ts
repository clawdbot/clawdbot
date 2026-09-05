import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type {
  OutboundPayloadDeliveryOutcome,
  OutboundPayloadDeliverySuppressionReason,
} from "./deliver-types.js";
import { summarizeOutboundPayloadForTransport } from "./payloads.js";

export const PREPARED_OUTBOUND_BATCH_SCHEMA_VERSION = 1 as const;

type PreparedOutboundAcceptedEntry = {
  sourceIndex: number;
  status: "accepted";
  payload: ReplyPayload;
  replyHookChanged: boolean;
  messageHookChanged: boolean;
  preparedMediaCount: number;
};

type PreparedOutboundSuppressedEntry = {
  sourceIndex: number;
  status: "suppressed";
  reason: OutboundPayloadDeliverySuppressionReason;
  hookEffect?: {
    cancelReason?: string;
    metadata?: Record<string, unknown>;
  };
};

export type PreparedOutboundBatchEntry =
  | PreparedOutboundAcceptedEntry
  | PreparedOutboundSuppressedEntry;

/** Canonical post-policy payload custody persisted by the durable outbound queue. */
export type PreparedOutboundBatch = {
  schemaVersion: typeof PREPARED_OUTBOUND_BATCH_SCHEMA_VERSION;
  sourcePayloadCount: number;
  /** True only when accepted payloads already passed post-policy channel normalization. */
  channelNormalized?: true;
  runId?: string;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
  entries: PreparedOutboundBatchEntry[];
};

/** Captures already-owned content without invoking modifying policy. */
export function createUnmodifiedPreparedOutboundBatch(
  payloads: readonly ReplyPayload[],
): PreparedOutboundBatch {
  return {
    schemaVersion: PREPARED_OUTBOUND_BATCH_SCHEMA_VERSION,
    sourcePayloadCount: payloads.length,
    entries: payloads.map((payload, sourceIndex) => ({
      sourceIndex,
      status: "accepted",
      payload,
      replyHookChanged: false,
      messageHookChanged: false,
      preparedMediaCount: summarizeOutboundPayloadForTransport(payload).mediaUrls.length,
    })),
  };
}

/** Retains terminal legacy cardinality without copying unavailable pre-policy content. */
export function createUnavailablePreparedOutboundBatch(
  sourcePayloadCount: number,
): PreparedOutboundBatch {
  return {
    schemaVersion: PREPARED_OUTBOUND_BATCH_SCHEMA_VERSION,
    sourcePayloadCount,
    entries: [],
  };
}

export function acceptedPreparedOutboundEntries(
  batch: PreparedOutboundBatch,
): PreparedOutboundAcceptedEntry[] {
  return batch.entries.filter(
    (entry): entry is PreparedOutboundAcceptedEntry => entry.status === "accepted",
  );
}

export function preparedOutboundSuppressionOutcomes(
  batch: PreparedOutboundBatch,
): OutboundPayloadDeliveryOutcome[] {
  return batch.entries.flatMap((entry) =>
    entry.status === "suppressed"
      ? [
          {
            index: entry.sourceIndex,
            status: "suppressed" as const,
            reason: entry.reason,
            ...(entry.hookEffect ? { hookEffect: entry.hookEffect } : {}),
          },
        ]
      : [],
  );
}

/** Removes process-local hook details before a prepared batch enters durable custody. */
export function projectPreparedOutboundBatchForStorage(
  batch: PreparedOutboundBatch,
): PreparedOutboundBatch {
  return {
    ...batch,
    entries: batch.entries.map((entry) => {
      if (entry.status !== "suppressed" || !entry.hookEffect) {
        return entry;
      }
      const { hookEffect: _hookEffect, ...stored } = entry;
      return stored;
    }),
  };
}

export function mapPreparedOutboundAcceptedPayloads(
  batch: PreparedOutboundBatch,
  payloads: readonly ReplyPayload[],
): PreparedOutboundBatch {
  let acceptedIndex = 0;
  const mapped = {
    ...batch,
    entries: batch.entries.map((entry) => {
      if (entry.status !== "accepted") {
        return entry;
      }
      const payload = payloads[acceptedIndex++];
      if (!payload) {
        throw new Error("Prepared outbound payload map lost an accepted entry");
      }
      return { ...entry, payload };
    }),
  };
  if (acceptedIndex !== payloads.length) {
    throw new Error("Prepared outbound payload map received an extra payload");
  }
  return mapped;
}
