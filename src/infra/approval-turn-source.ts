import { getRuntimeConfig } from "../config/config.js";
import { resolveExecApprovalInitiatingSurfaceState } from "./exec-approval-surface.js";

export function hasApprovalTurnSourceRoute(params: {
  turnSourceChannel?: string | null;
  turnSourceAccountId?: string | null;
}): boolean {
  if (!params.turnSourceChannel?.trim()) {
    return false;
  }
  return (
    resolveExecApprovalInitiatingSurfaceState({
      channel: params.turnSourceChannel,
      accountId: params.turnSourceAccountId,
      cfg: getRuntimeConfig(),
    }).kind === "enabled"
  );
}
