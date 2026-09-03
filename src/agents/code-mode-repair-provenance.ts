const repairableFailureDetails = new WeakSet<object>();
const permissionChangeReasons = new WeakSet<object>();
const permissionChangedFailureDetails = new WeakSet<object>();

/** Mint the exact host-owned reason for an operator's permission transition. */
export function createCodeModePermissionChangeReason(): Error {
  const reason = new Error("Permission change");
  permissionChangeReasons.add(reason);
  return reason;
}

/** Preserve the operator transition without claiming interrupted actions never started. */
export function markCodeModePermissionChangeResult(
  details: { status: string; code?: unknown; error?: unknown },
  signal?: AbortSignal,
): void {
  const reason: unknown = signal?.reason;
  if (
    details.status === "failed" &&
    details.code === "aborted" &&
    signal?.aborted &&
    reason instanceof Error &&
    permissionChangeReasons.has(reason)
  ) {
    details.error =
      "Permission change interrupted this Code Mode program. Continue the current task using the updated permissions. Do not replay this program or repeat completed actions. Any in-flight action may have partially applied; inspect authoritative state before deciding what work remains.";
    permissionChangedFailureDetails.add(details);
  }
}

/** Only the exact host-finalized cancellation result may continue under the new policy. */
export function consumeCodeModePermissionChangeResult(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    permissionChangedFailureDetails.delete(details)
  );
}

/** Attach host-only repair authority to one finalized Code Mode failure payload. */
export function registerRepairableCodeModeFailure(details: object): void {
  repairableFailureDetails.add(details);
}

/** Consume repair authority from the exact host-created failure payload. */
export function consumeRepairableCodeModeFailure(details: unknown): boolean {
  return (
    typeof details === "object" && details !== null && repairableFailureDetails.delete(details)
  );
}
