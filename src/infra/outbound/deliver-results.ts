// Reconciles adapter progress results with hook-bearing final delivery results.
import { expectDefined } from "@openclaw/normalization-core";
import { hasDeliveryResultIdentity } from "./deliver-payload.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";

export function createDeliveryResultRecorder(params: {
  results: OutboundDeliveryResult[];
  onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
}) {
  const results = params.results;
  let reportedResults: Array<{ identityKey: string; resultIndex: number }> = [];
  const resultIdentityKey = (delivery: OutboundDeliveryResult): string =>
    JSON.stringify([
      delivery.channel,
      delivery.messageId,
      delivery.chatId,
      delivery.channelId,
      delivery.roomId,
      delivery.conversationId,
      delivery.timestamp,
      delivery.toJid,
      delivery.pollId,
    ]);
  const resultPlatformIds = (
    delivery: OutboundDeliveryResult,
    options?: { receiptOnly?: boolean },
  ): Set<string> => {
    const ids = new Set<string>();
    const add = (value: string | undefined) => {
      const id = value?.trim();
      if (id && id !== "unknown" && id !== "suppressed") {
        ids.add(id);
      }
    };
    if (!options?.receiptOnly) {
      add(delivery.messageId);
    }
    add(delivery.receipt?.primaryPlatformMessageId);
    for (const id of delivery.receipt?.platformMessageIds ?? []) {
      add(id);
    }
    for (const part of delivery.receipt?.parts ?? []) {
      add(part.platformMessageId);
    }
    return ids;
  };
  const reportIdentifiedDeliveryResult = async (
    delivery: OutboundDeliveryResult,
  ): Promise<void> => {
    if (!hasDeliveryResultIdentity(delivery)) {
      return;
    }
    const resultIndex = results.length;
    results.push(delivery);
    reportedResults.push({ identityKey: resultIdentityKey(delivery), resultIndex });
    // Persist concrete platform evidence before pinning, hooks, mirroring, or
    // another send can fail or the process can stop.
    await params.onDeliveryResult?.(delivery);
  };
  const recordIdentifiedDeliveryResults = async (
    deliveries: readonly OutboundDeliveryResult[],
    options?: { finalResultIsLastReported?: boolean },
  ): Promise<boolean[]> => {
    const reportedByIdentity = new Map<string, number[]>();
    for (const reported of reportedResults) {
      const matches = reportedByIdentity.get(reported.identityKey) ?? [];
      matches.push(reported.resultIndex);
      reportedByIdentity.set(reported.identityKey, matches);
    }
    try {
      const recorded: boolean[] = [];
      const availableReportedIndices = new Set(
        reportedResults.map((reported) => reported.resultIndex),
      );
      const replacements = new Map<number, OutboundDeliveryResult>();
      const removals = new Set<number>();
      const appendResults: OutboundDeliveryResult[] = [];
      for (const delivery of deliveries) {
        if (!hasDeliveryResultIdentity(delivery)) {
          recorded.push(false);
          continue;
        }
        const receiptPartIds = (delivery.receipt?.parts ?? [])
          .map((part) => part.platformMessageId?.trim())
          .filter((id): id is string => Boolean(id && id !== "unknown" && id !== "suppressed"));
        const receiptIds =
          receiptPartIds.length > 0
            ? receiptPartIds
            : [...resultPlatformIds(delivery, { receiptOnly: true })];
        const coveredIndices: number[] = [];
        for (const receiptId of receiptIds) {
          const matchingIndices = reportedResults
            .filter(
              (reported) =>
                availableReportedIndices.has(reported.resultIndex) &&
                !coveredIndices.includes(reported.resultIndex) &&
                results[reported.resultIndex]?.channel === delivery.channel &&
                resultPlatformIds(
                  expectDefined(
                    results[reported.resultIndex],
                    "results entry at reported.result index",
                  ),
                ).has(receiptId),
            )
            .map((reported) => reported.resultIndex);
          // One receipt part covers one progress result. Repeated parts preserve
          // aggregate multiplicity, while one constant platform ID cannot erase
          // other successful sends that the final receipt does not aggregate.
          const matchingIndex = options?.finalResultIsLastReported
            ? matchingIndices.at(-1)
            : matchingIndices[0];
          if (matchingIndex !== undefined && !coveredIndices.includes(matchingIndex)) {
            coveredIndices.push(matchingIndex);
          }
        }
        let reportedIndex: number | undefined;
        if (coveredIndices.length > 0) {
          reportedIndex = Math.min(...coveredIndices);
          for (const coveredIndex of coveredIndices) {
            availableReportedIndices.delete(coveredIndex);
            if (coveredIndex !== reportedIndex) {
              removals.add(coveredIndex);
            }
          }
        } else {
          const reportedMatches = (
            reportedByIdentity.get(resultIdentityKey(delivery)) ?? []
          ).filter((index) => availableReportedIndices.has(index));
          reportedIndex = options?.finalResultIsLastReported
            ? reportedMatches.at(-1)
            : reportedMatches[0];
          if (reportedIndex !== undefined) {
            availableReportedIndices.delete(reportedIndex);
          }
        }
        if (reportedIndex !== undefined) {
          // Replace all progress covered by an aggregate receipt with the final
          // hook-bearing object, avoiding duplicate receipt parts.
          replacements.set(reportedIndex, delivery);
        } else {
          appendResults.push(delivery);
        }
        recorded.push(true);
      }
      if (replacements.size > 0 || removals.size > 0) {
        const reconciled = results.flatMap((result, index) => {
          if (removals.has(index)) {
            return [];
          }
          return [replacements.get(index) ?? result];
        });
        results.splice(0, results.length, ...reconciled);
      }
      for (const delivery of appendResults) {
        results.push(delivery);
        await params.onDeliveryResult?.(delivery);
      }
      return recorded;
    } finally {
      // Progress matching is scoped to exactly one adapter invocation. IDs such
      // as LINE's constant "push" value can legitimately repeat later.
      reportedResults = [];
    }
  };
  const recordIdentifiedDeliveryResult = async (
    delivery: OutboundDeliveryResult,
  ): Promise<boolean> =>
    (
      await recordIdentifiedDeliveryResults([delivery], {
        finalResultIsLastReported: true,
      })
    )[0] ?? false;
  return {
    recordIdentifiedDeliveryResult,
    recordIdentifiedDeliveryResults,
    reportIdentifiedDeliveryResult,
    resetReportedResults: () => {
      reportedResults = [];
    },
  };
}
