export type ShardTargetPlan = {
  kind: "target";
  name: string;
  target: string;
};

export type ShardGroupPlan = {
  kind: "group";
  name: string;
  plan: {
    configs: string[];
    env?: Record<string, unknown> | null;
    includePatterns?: string[] | null;
    shard_name?: string;
  };
};

export type ShardPlan = ShardTargetPlan | ShardGroupPlan;

export type FsModuleCachePruneResult = {
  beforeBytes: number;
  afterBytes: number;
  removedFiles: number;
};

export function resolveShardPlans(env?: Record<string, string | undefined>): ShardPlan[];

export function buildChildEnv(
  entry: ShardPlan,
  baseEnv: Record<string, string | undefined>,
  scratchDir: string,
  index: number,
  options?: { serial?: boolean; cacheSlot?: number },
): Record<string, string | undefined>;

export function pruneFsModuleCache(root: string, maxBytes?: number): FsModuleCachePruneResult;

export function resolveShardChildCommand(
  args: string[],
  nodeExecPath?: string,
): { command: string; args: string[] };

export function runShardPlans(
  plans: ShardPlan[],
  options?: {
    concurrency?: number;
    env?: Record<string, string | undefined>;
    fsModuleCacheMaxBytes?: number;
    nodeCompileCacheMaxBytes?: number;
    runChild?: (
      args: string[],
      childEnv: Record<string, string | undefined>,
      label: string,
    ) => Promise<number>;
    scratchDir?: string;
  },
): Promise<number>;
