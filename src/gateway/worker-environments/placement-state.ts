const WORKER_SESSION_PLACEMENT_STATES = [
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

export type WorkerSessionPlacementState = (typeof WORKER_SESSION_PLACEMENT_STATES)[number];

type WorkerSessionPlacementTransition = {
  [From in WorkerSessionPlacementState]: readonly WorkerSessionPlacementState[];
};

const WORKER_SESSION_PLACEMENT_TRANSITIONS = {
  local: ["requested"],
  requested: ["provisioning", "failed"],
  provisioning: ["syncing", "failed"],
  syncing: ["starting", "failed"],
  starting: ["active", "failed"],
  active: ["draining"],
  draining: ["reconciling"],
  reconciling: ["local", "reclaimed", "failed"],
  reclaimed: ["requested"],
  failed: [],
} as const satisfies WorkerSessionPlacementTransition;

export function parseWorkerSessionPlacementState(value: string): WorkerSessionPlacementState {
  if ((WORKER_SESSION_PLACEMENT_STATES as readonly string[]).includes(value)) {
    return value as WorkerSessionPlacementState;
  }
  throw new Error(`Invalid worker session placement state: ${value}`);
}

export function canTransitionWorkerSessionPlacement(
  from: WorkerSessionPlacementState,
  to: WorkerSessionPlacementState,
): boolean {
  return (
    WORKER_SESSION_PLACEMENT_TRANSITIONS[from] as readonly WorkerSessionPlacementState[]
  ).includes(to);
}
