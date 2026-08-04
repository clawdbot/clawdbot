import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  resolveSubagentRunDeadlineMs,
  resolveSubagentRunEffectiveEndedAt,
} from "./subagent-run-timeout.js";

type BrowserCleanupModule = Pick<
  typeof import("../browser-lifecycle-cleanup.js"),
  "cleanupBrowserSessionsForLifecycleEnd"
>;

const browserCleanupLoader = createLazyImportLoader<BrowserCleanupModule>(
  () => import("../browser-lifecycle-cleanup.js"),
);

export async function loadCleanupBrowserSessionsForLifecycleEnd(): Promise<
  BrowserCleanupModule["cleanupBrowserSessionsForLifecycleEnd"]
> {
  return (await browserCleanupLoader.load()).cleanupBrowserSessionsForLifecycleEnd;
}

export function shouldPreservePublishedExplicitRunTimeout(params: {
  entry: SubagentRunRecord;
}): boolean {
  if (
    typeof params.entry.runTimeoutSeconds !== "number" ||
    !Number.isFinite(params.entry.runTimeoutSeconds) ||
    params.entry.runTimeoutSeconds <= 0 ||
    params.entry.execution.outcome?.status !== "timeout" ||
    typeof params.entry.execution.endedAt !== "number"
  ) {
    return false;
  }
  const deadlineMs = resolveSubagentRunDeadlineMs(params.entry);
  if (deadlineMs === undefined || params.entry.execution.endedAt < deadlineMs) {
    return false;
  }
  if (
    params.entry.cleanupHandled ||
    typeof params.entry.cleanupCompletedAt === "number" ||
    typeof params.entry.endedHookEmittedAt === "number" ||
    params.entry.delivery?.status === "delivered" ||
    typeof params.entry.delivery?.announcedAt === "number"
  ) {
    return true;
  }
  return false;
}

export function resolveExpiredExplicitRunDeadlineMs(params: {
  entry: SubagentRunRecord;
  nextEndedAt: number;
  observedStartedAt?: number;
}): number | undefined {
  const effectiveEndedAt = resolveSubagentRunEffectiveEndedAt(
    params.entry,
    params.nextEndedAt,
    params.observedStartedAt,
  );
  return effectiveEndedAt < params.nextEndedAt ? effectiveEndedAt : undefined;
}

export function isOlderEquivalentTerminalCallback(params: {
  entry: SubagentRunRecord;
  endedAt: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
}): boolean {
  const current = params.entry.execution.outcome;
  if (
    typeof params.entry.execution.endedAt !== "number" ||
    params.endedAt >= params.entry.execution.endedAt ||
    params.entry.endedReason !== params.reason ||
    current?.status !== params.outcome.status
  ) {
    return false;
  }
  return (
    current.status !== "error" ||
    params.outcome.status !== "error" ||
    current.error === params.outcome.error
  );
}
