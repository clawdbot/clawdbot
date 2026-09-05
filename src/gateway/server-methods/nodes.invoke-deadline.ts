import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../../utils/absolute-deadline.js";

export const NODE_INVOKE_DEADLINE_EXPIRED: typeof ABSOLUTE_DEADLINE_EXPIRED =
  ABSOLUTE_DEADLINE_EXPIRED;

/** Bounds node pairing, wake, policy, and transport preparation by one absolute deadline. */
export async function awaitNodeInvokeWithinDeadline<T>(
  operation: () => Promise<T>,
  deadlineAtMs: number | undefined,
): Promise<T | typeof NODE_INVOKE_DEADLINE_EXPIRED> {
  return await awaitWithinDeadline(operation, deadlineAtMs);
}
