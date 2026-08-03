/** Create balanced plugin contract test shards for CI check planning. */
export function createPluginContractTestShards(): {
  checkName: string;
  includePatterns: string[];
  runtime: string;
  task: string;
}[];
