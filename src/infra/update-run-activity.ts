import { inspectUpdateRunDriver, type UpdateRunDriver } from "./update-run-driver.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { ABANDONED_UPDATE_RUN_MS } from "./update-run-timeouts.js";

function updateRunLastActivity(record: UpdateRunRecord): number {
  return Math.max(
    record.updatedAtMs,
    ...record.steps.flatMap((step) => [step.startedAtMs ?? 0, step.endedAtMs ?? 0]),
  );
}

export function isStaleIdentitylessUpdateRun(record: UpdateRunRecord): boolean {
  return (
    record.status === "running" &&
    !record.origin.driver &&
    !record.origin.previousDrivers?.length &&
    Date.now() - updateRunLastActivity(record) > ABANDONED_UPDATE_RUN_MS
  );
}

export function recordedUpdateRunDrivers(record: UpdateRunRecord): UpdateRunDriver[] {
  return [
    ...(record.origin.driver ? [record.origin.driver] : []),
    ...(record.origin.previousDrivers ?? []),
  ];
}

/** Only a fresh, unacknowledged recovery may substitute for a full repair invocation. */
export function isUnacknowledgedAbandonedUpdateRun(record: UpdateRunRecord): boolean {
  return (
    record.status === "failed" &&
    record.reason === "abandoned" &&
    record.finishedAtMs !== null &&
    record.finishedAtMs <= Date.now() &&
    Date.now() - record.finishedAtMs <= ABANDONED_UPDATE_RUN_MS &&
    !record.steps.some((step) => step.step === "reconcile:acknowledged")
  );
}

/** Read-only classification; an unobservable process is never presumed dead. */
export function inspectUpdateRunAbandonment(
  record: UpdateRunRecord,
  input: { explicit?: boolean } = {},
): string | undefined {
  const lastActivity = updateRunLastActivity(record);
  if (record.status !== "running" || Date.now() - lastActivity <= ABANDONED_UPDATE_RUN_MS) {
    return undefined;
  }
  if (!input.explicit && record.steps.some((step) => step.step === "driver:identity-unavailable")) {
    return undefined;
  }
  const drivers = recordedUpdateRunDrivers(record);
  if (drivers.length) {
    return drivers.every((driver) => inspectUpdateRunDriver(driver) === "dead")
      ? "inactive-driver-dead"
      : undefined;
  }
  return input.explicit ? "operator-reconciled-inactive-run" : undefined;
}

/** Legacy activity cannot prove death; reporting must leave recovery to the operator. */
export function staleUpdateRunGuidance(record: UpdateRunRecord): string | undefined {
  return isStaleIdentitylessUpdateRun(record)
    ? `no activity since ${new Date(updateRunLastActivity(record)).toISOString()}; if no update is running, run \`openclaw update repair\` or start a new \`openclaw update\``
    : undefined;
}
