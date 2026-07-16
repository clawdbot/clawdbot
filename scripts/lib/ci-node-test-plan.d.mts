export type NodeTestShardGroup = {
  shard_name: string;
  configs: string[];
  includePatterns?: string[];
  requiresDist: boolean;
  runner: string;
  env?: Record<string, string>;
};

export type NodeTestShard = {
  checkName: string;
  shardName: string;
  configs: string[];
  runner: string;
  requiresDist: boolean;
  includePatterns?: string[];
  env?: Record<string, string>;
  groups?: NodeTestShardGroup[];
  timeoutMinutes?: number;
  planConcurrency?: number;
};

export type NodeTestPlanOptions = {
  includeReleaseOnlyPluginShards?: boolean;
  compact?: boolean;
  compactGroupCount?: number;
  compactWholeGroupCount?: number;
};

export type CompactNodeTestShard = Omit<NodeTestShard, "configs" | "groups"> & {
  groups: NodeTestShardGroup[];
};

export function createNodeTestShards(options?: NodeTestPlanOptions): NodeTestShard[];
export function createNodeTestShardBundles(
  options: NodeTestPlanOptions & { compact: true },
): CompactNodeTestShard[];
export function createNodeTestShardBundles(options?: NodeTestPlanOptions): NodeTestShard[];
