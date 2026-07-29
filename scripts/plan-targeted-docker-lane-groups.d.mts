/**
 * Groups selected Docker lanes and expands sharded upgrade-survivor baselines.
 */
export function planTargetedDockerLaneGroups({
  groupSize,
  lanes,
  upgradeSurvivorBaselines,
}?: {
  groupSize?: number | string | undefined;
  lanes?: string | undefined;
  upgradeSurvivorBaselines?: string | undefined;
}): {
  docker_lanes: string;
  label: string;
  published_upgrade_survivor_baselines: string;
}[];
