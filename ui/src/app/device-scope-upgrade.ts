import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";

export type ScopeUpgradeState =
  | { phase: "hidden" }
  | { phase: "available" }
  | { phase: "requesting" }
  | { phase: "pending"; requestId: string }
  | { phase: "rejected"; requestId: string; expired: boolean }
  | { phase: "error"; message: string };

export function readScopeUpgradeAvailability(
  snapshot: ApplicationGatewaySnapshot,
): ScopeUpgradeState {
  const auth = snapshot.hello?.auth;
  return snapshot.phase === "connected" &&
    auth?.scopes !== undefined &&
    !hasOperatorAdminAccess(auth)
    ? { phase: "available" }
    : { phase: "hidden" };
}
