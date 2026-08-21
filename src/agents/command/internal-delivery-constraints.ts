/**
 * Restart-recovery internal delivery must not reach channels through ordinary
 * tool paths: media-bearing or text-suppressed recovery turns are only safe
 * with automatic delivery, restart-safe tools, and the message tool disabled.
 */
import type { AgentCommandOpts } from "./types.js";

export function assertInternalDeliveryConstraints(preparedOpts: AgentCommandOpts): void {
  if (
    (preparedOpts.internalDeliverySuppressText === true &&
      preparedOpts.internalDeliveryMediaUrls === undefined) ||
    ((preparedOpts.internalDeliveryMediaUrls !== undefined ||
      preparedOpts.internalDeliverySuppressText === true) &&
      (preparedOpts.forceRestartSafeTools !== true ||
        preparedOpts.disableMessageTool !== true ||
        preparedOpts.sourceReplyDeliveryMode !== "automatic"))
  ) {
    throw new Error(
      "internal delivery media constraints require automatic delivery with restart-safe tools and no message tool",
    );
  }
}
