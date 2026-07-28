/**
 * Shared state types and small helpers for the durable channel-ingress drain.
 * Kept separate from ingress-drain.ts to keep the drain orchestration readable
 * (and under the file-size lint budget).
 */
import type { ChannelIngressQueueClaim, ChannelIngressQueueRecord } from "./ingress-queue.js";

export type ActiveHandlerState<TPayload, TMetadata> = {
  eventId: string;
  laneKey: string;
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>;
  abortController: AbortController;
  startedAt: number;
  phase: "dispatching" | "deferred" | "adopted" | "settled";
  task: Promise<void>;
  stallTimer?: ReturnType<typeof setTimeout>;
  claimRefreshTimer?: ReturnType<typeof setInterval>;
  /** Closed code: pre-adoption stall watchdog has claimed settle ownership. */
  guillotined: boolean;
  /** Closed code: pre-adoption supersede has claimed settle ownership. */
  superseded: boolean;
  /** Single settle owner for complete / fail / release / supersede / guillotine. */
  settleOnce: (fn: () => Promise<void>) => Promise<void>;
};

export function resolveIngressDrainLaneKey<TPayload, TMetadata>(
  record: ChannelIngressQueueRecord<TPayload, TMetadata>,
  deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined,
): string {
  return deriveLaneKey?.(record) ?? record.laneKey ?? record.id;
}

export function sortedIngressDrainKeys(keys: Iterable<string>): string[] {
  return [...keys].toSorted((a, b) => a.localeCompare(b));
}
