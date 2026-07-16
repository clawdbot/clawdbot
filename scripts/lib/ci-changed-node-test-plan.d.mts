export type ChangedNodeTestShard = {
  checkName: string;
  configs: string[];
  requiresDist: boolean;
  runner: string;
  shardName: string;
  targets?: string[];
};

export function createChangedNodeTestShards(
  changedPaths: string[],
  options?: { cwd?: string },
): ChangedNodeTestShard[] | null;

export function hasBuildArtifactAffectingChange(changedPaths: string[]): boolean;

export function hasPromptSnapshotAffectingChange(
  changedPaths: string[],
  options?: { cwd?: string },
): boolean;

export function hasQaSmokeAffectingChange(changedPaths: string[]): boolean;
