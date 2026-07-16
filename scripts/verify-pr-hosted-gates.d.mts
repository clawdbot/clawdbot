#!/usr/bin/env node
export function parseArgs(argv: unknown): {
  repo: string;
  sha: string;
  pr: number;
  recentSha: string;
  output: string;
  changelogOnly: boolean;
};
export function parseWorkflowRunPage(raw: unknown): {
  totalCount: unknown;
  workflowRuns: unknown;
};
export function workflowRunPageCount(totalCount: unknown): number;
export function collectHostedGateEvidence({
  sha,
  pr,
  recentSha,
  pullRequestCommitShas,
  pullRequestHeadBranch,
  pullRequestHeadRepository,
  workflowRuns,
  changelogOnly,
  nowMs,
}: {
  sha: string;
  pr?: number;
  recentSha?: string;
  pullRequestCommitShas?: string[];
  pullRequestHeadBranch?: string;
  pullRequestHeadRepository?: string;
  workflowRuns: Array<Record<string, unknown>>;
  changelogOnly?: boolean | undefined;
  nowMs?: number | undefined;
}): {
  headSha: string;
  evidenceHeadSha?: string;
  workflows: {
    id: unknown;
    name: unknown;
    event: unknown;
    headSha: unknown;
    headBranch: unknown;
    status: unknown;
    conclusion: unknown;
    createdAt: unknown;
    updatedAt: unknown;
    url: unknown;
  }[];
  fallbackCoveredWorkflows?: {
    name: string;
    coveredBy: string;
    reason: string;
  }[];
};
export function compareCommitPageCount(totalCommits: number): number;
export function workflowRunQueryPaths(
  repo: string,
  {
    sha,
    recentSha,
    headBranch,
  }: {
    sha: string;
    recentSha: string;
    headBranch?: string;
  },
  page?: number,
): string[];
export function main(argv?: string[]): void;
export const SCHEDULED_HOSTED_WORKFLOWS: string[];
export const HOSTED_GATE_MAX_AGE_HOURS: 24;
