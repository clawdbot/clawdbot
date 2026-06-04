// Checks whether an approval reply can route to the initiating turn source.
import { getRuntimeConfig } from "../config/config.js";
import { resolveApprovalInitiatingSurfaceState } from "./exec-approval-surface.js";

/** Returns whether approval replies can route back to the turn's initiating surface. */
export function hasApprovalTurnSourceRoute(params: {
  turnSourceChannel?: string | null;
  turnSourceAccountId?: string | null;
  approvalKind?: "exec" | "plugin";
}): boolean {
  if (!params.turnSourceChannel?.trim()) {
    return false;
  }
  return (
    resolveApprovalInitiatingSurfaceState({
      channel: params.turnSourceChannel,
      accountId: params.turnSourceAccountId,
      cfg: getRuntimeConfig(),
      approvalKind: params.approvalKind ?? "exec",
    }).kind === "enabled"
  );
}
