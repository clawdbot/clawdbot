/**
 * Marks subagent completions consumed by requester-owned orchestration paths.
 */
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { setDetachedTaskDeliveryStatusByRunId } from "../tasks/detached-task-runtime.js";
import { ensureDeliveryState } from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";

export function markDescendantCompletionConsumedByRequester(params: {
  requesterSessionKey: string;
  runStartedAt: number;
  runIds: readonly string[];
}): number {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const runIds = normalizeUniqueStringEntries(params.runIds);
  if (!requesterSessionKey || runIds.length === 0) {
    return 0;
  }

  restoreSubagentRunsFromDisk({ runs: subagentRuns, mergeOnly: true });

  const now = Date.now();
  let updated = 0;
  for (const runId of runIds) {
    const entry = subagentRuns.get(runId);
    if (!entry || entry.requesterSessionKey !== requesterSessionKey) {
      continue;
    }
    const descendantStartedAt = entry.execution.startedAt ?? entry.createdAt;
    if (typeof descendantStartedAt === "number" && descendantStartedAt < params.runStartedAt) {
      continue;
    }
    if (typeof entry.execution.endedAt !== "number" || entry.expectsCompletionMessage !== true) {
      continue;
    }
    const delivery = ensureDeliveryState(entry);
    delivery.status = "delivered";
    delivery.deliveredAt ??= now;
    delivery.requesterConsumedAt ??= now;
    delivery.suspendedAt = undefined;
    delivery.suspendedReason = undefined;
    delivery.lastError = undefined;
    delivery.lastDropReason = undefined;
    entry.wakeOnDescendantSettle = undefined;
    try {
      setDetachedTaskDeliveryStatusByRunId({
        runId: entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        deliveryStatus: "delivered",
      });
    } catch {
      // The registry credit is the durable source of truth; task rows can be
      // absent in tests or after pruning and should not block cleanup.
    }
    updated += 1;
  }
  if (updated > 0) {
    persistSubagentRunsToDisk(subagentRuns);
  }
  return updated;
}
