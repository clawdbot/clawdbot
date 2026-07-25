/** Create balanced channel contract test shards for CI check planning. */
export function createChannelContractTestShards(): {
  checkName: string;
  includePatterns: string[];
  task: string;
  runtime: string;
}[];
