import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listTasksForOwnerKey } from "../tasks/runtime-internal.js";
import { getSubagentRunByChildSessionKey } from "./subagent-registry.js";

function isActiveTaskStatus(status: string | undefined): boolean {
  return status === "queued" || status === "running";
}

export function countUntrackedActiveAcpRunsForOwner(
  ownerKey: string | undefined,
  pendingChildSessionKeys?: ReadonlySet<string>,
): number {
  const normalizedOwnerKey = normalizeOptionalString(ownerKey);
  if (!normalizedOwnerKey) {
    return 0;
  }
  const tasks = listTasksForOwnerKey(normalizedOwnerKey);
  const trackedChildSessionKeys = new Set(
    tasks
      .filter(
        (task) =>
          task.runtime === "subagent" &&
          isActiveTaskStatus(task.status) &&
          normalizeOptionalString(task.childSessionKey),
      )
      .map((task) => normalizeOptionalString(task.childSessionKey) as string),
  );
  const activeAcpChildSessionKeys = new Set(
    tasks.flatMap((task) => {
      const childSessionKey = normalizeOptionalString(task.childSessionKey);
      const trackedRun = childSessionKey ? getSubagentRunByChildSessionKey(childSessionKey) : null;
      const hasActiveRegistryRun = Boolean(
        trackedRun && typeof trackedRun.execution.endedAt !== "number",
      );
      return task.runtime === "acp" &&
        isActiveTaskStatus(task.status) &&
        childSessionKey !== undefined &&
        !pendingChildSessionKeys?.has(childSessionKey) &&
        !hasActiveRegistryRun &&
        !trackedChildSessionKeys.has(childSessionKey)
        ? [childSessionKey]
        : [];
    }),
  );
  return activeAcpChildSessionKeys.size;
}
