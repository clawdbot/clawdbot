export type ExtensionTestPlanGroup = {
  config: string;
  estimatedCost: number;
  extensionIds: string[];
  roots: string[];
  testFileCount: number;
};

export type ExtensionBatchPlan = {
  extensionCount: number;
  extensionIds: string[];
  estimatedCost: number;
  hasTests: boolean;
  noTestExtensionIds?: string[];
  planGroups: ExtensionTestPlanGroup[];
  testFileCount: number;
};

export type ExtensionTestShard = ExtensionBatchPlan & {
  checkName: string;
};

export const DEFAULT_EXTENSION_TEST_SHARD_COUNT: number;
export function listTrackedTestFilesForRoots(roots: string[]): string[];
export function resolveExtensionTestConfig(root: string): string;
export function resolveExtensionTestPlan(params?: {
  cwd?: string;
  targetArg?: string;
}): ExtensionTestPlanGroup & {
  extensionDir: string;
  extensionId: string;
  hasTests: boolean;
};
export function resolveExtensionBatchPlan(params?: {
  cwd?: string;
  extensionIds?: string[];
}): ExtensionBatchPlan;
export function createExtensionTestShards(params?: {
  cwd?: string;
  extensionIds?: string[];
  shardCount?: number | string;
}): ExtensionTestShard[];
