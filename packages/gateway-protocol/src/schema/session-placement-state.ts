// Placement-state vocabulary shared by the schema layer, the gateway, and
// the Control UI. Keep this module dependency-free: the browser imports it
// at runtime, and a typebox import here would pull the entire schema layer
// into the Control UI startup bundle (which has a hard size budget).
export const SESSION_PLACEMENT_STATES = [
  "local",
  "requested",
  "provisioning",
  "syncing",
  "starting",
  "active",
  "draining",
  "reconciling",
  "reclaimed",
  "failed",
] as const;

export type SessionPlacementState = (typeof SESSION_PLACEMENT_STATES)[number];

export function isCloudWorkerPlacementState(
  state: SessionPlacementState | undefined,
): state is Exclude<SessionPlacementState, "local" | "reclaimed"> {
  return state !== undefined && state !== "local" && state !== "reclaimed";
}
