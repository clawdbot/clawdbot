// Checks whether an approval reply can route to the initiating turn source.
import { getRuntimeConfig } from "../config/config.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveApprovalInitiatingSurfaceState } from "./exec-approval-surface.js";

/** Returns whether approval replies can route back to the turn's initiating surface. */
export function hasApprovalTurnSourceRoute(params: {
  turnSourceChannel?: string | null;
  turnSourceAccountId?: string | null;
  approvalKind?: "exec" | "plugin";
}): boolean {
  const channel = normalizeMessageChannel(params.turnSourceChannel);
  // INTERNAL_MESSAGE_CHANNEL is webchat; web and TUI routes exist only while
  // their approval-capable Gateway clients are connected and counted separately.
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return false;
  }
  return (
    resolveApprovalInitiatingSurfaceState({
      channel,
      accountId: params.turnSourceAccountId,
      cfg: getRuntimeConfig(),
      approvalKind: params.approvalKind ?? "exec",
    }).kind === "enabled"
  );
}
