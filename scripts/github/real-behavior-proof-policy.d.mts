export const PROOF_OVERRIDE_LABEL: "proof: override";
export const PROOF_SUFFICIENT_LABEL: "proof: sufficient";
export const NEEDS_PR_CONTEXT_LABEL: "triage: needs-pr-context";
export const DEFAULT_GITHUB_API_TIMEOUT_MS: 30000;

type PullRequest = Record<string, unknown>;
type Comment = Record<string, unknown>;
type Evaluation = {
  status: string;
  reason: string;
  applies: boolean;
  passed: boolean;
  missingSections: string[];
};

export function readBoundedGitHubApiJson(
  response: Response,
  label: string,
  maxBytes?: number,
  options?: { timeoutMs?: number },
): Promise<unknown>;
export function isMaintainerTeamMember(params?: {
  token?: string;
  org?: string;
  login?: string;
  teamSlug?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<boolean>;
export function hasAuthoredPullRequestSection(heading: string, body?: string): boolean;
export function hasClawSweeperExactHeadProof(params?: {
  pullRequest?: PullRequest;
  comments?: Comment[];
}): boolean;
export function evaluateClawSweeperExactHeadProof(params?: {
  pullRequest?: PullRequest;
  comments?: Comment[];
}): Evaluation;
export function evaluatePullRequestContext(params?: { pullRequest?: PullRequest }): Evaluation;
export function labelsForPullRequestContext(evaluation: Evaluation): string[];
