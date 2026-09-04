const permissionChangeReasons = new WeakSet<object>();

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
  }
}
