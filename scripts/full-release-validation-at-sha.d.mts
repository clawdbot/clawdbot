#!/usr/bin/env node
export function parseArgs(argv: unknown): {
  sha: string;
  workflowSha: string;
  keepBranch: boolean;
  dryRun: boolean;
  inputs: {
    provider: string;
    mode: string;
    release_profile: string;
    rerun_group: string;
    reuse_evidence: string;
  };
};
export function releaseEvidenceVerificationArgs(parentRunId: unknown): string[];
export function releaseEvidenceVerifierPath(worktreeRoot: unknown): string;
