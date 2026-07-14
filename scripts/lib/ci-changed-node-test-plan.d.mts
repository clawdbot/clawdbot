export type ChangedNodeTestShard = {
  checkName: string;
  configs: string[];
  requiresDist: boolean;
  runner: string;
  shardName: string;
  targets: string[];
};

export function createChangedNodeTestShards(
  changedPaths: string[],
  options?: { cwd?: string },
): ChangedNodeTestShard[] | null;
