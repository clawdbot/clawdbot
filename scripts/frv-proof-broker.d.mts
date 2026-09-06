export type BrokerContext = {
  actor: string;
  correlation: string;
  landedSha: string;
  prNumber: number;
  repository: "openclaw/openclaw";
  runId: number;
  workflowSha: string;
};

export type GitHubApi = {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
};

export type FixtureRunExpectation = {
  attempt: number;
  branch: string;
  conclusion: "failure" | "success";
  correlation: string;
  headSha: string;
  repository: string;
  runId?: number;
};

export type ProofReceipt = {
  actor: string;
  correlation: string;
  fixtureRunAttempt: 2;
  fixtureRunId: number;
  landedSha: string;
  operation: "noop";
  prNumber: number;
  repository: "openclaw/openclaw";
  sourceRef: "refs/heads/main";
  workflowSha: string;
};

export function validateBrokerRequest(event: unknown, env: NodeJS.ProcessEnv): BrokerContext;
export function validateFixtureRun(
  value: unknown,
  expected: FixtureRunExpectation,
): Record<string, unknown>;
export function runProofBroker(options: {
  api: GitHubApi;
  env: NodeJS.ProcessEnv;
  event: unknown;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<ProofReceipt>;
export function createGitHubApi(options: {
  repository: string;
  token: string;
  fetchImpl?: typeof fetch;
}): GitHubApi;
