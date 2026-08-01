import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";

export async function settleQueuedFollowupPresentation(
  onQueuedFollowupSettled: InternalGetReplyOptions["onQueuedFollowupSettled"],
): Promise<void> {
  try {
    await onQueuedFollowupSettled?.();
  } catch (error) {
    defaultRuntime.error?.(
      `followup queue: queued presentation cleanup failed: ${formatErrorMessage(error)}`,
    );
  }
}
