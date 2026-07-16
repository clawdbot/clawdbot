export interface OpenClawNpmResumeRunRecord {
  conclusion?: unknown;
  event?: unknown;
  head_branch?: unknown;
  head_sha?: unknown;
  html_url?: unknown;
  path?: unknown;
  workflow_id?: unknown;
}

export interface OpenClawNpmResumeTagRecord {
  object?: {
    sha?: unknown;
    type?: unknown;
  };
  verification?: {
    verified?: unknown;
  };
}

export interface OpenClawNpmResumeJobRecord {
  conclusion?: unknown;
  name?: unknown;
}

export interface OpenClawNpmResumeValidationInput {
  canonicalWorkflowId: unknown;
  compareStatus: unknown;
  jobs: OpenClawNpmResumeJobRecord[];
  run: OpenClawNpmResumeRunRecord;
  tag: OpenClawNpmResumeTagRecord;
  tagRef: OpenClawNpmResumeTagRecord;
}

export interface OpenClawNpmResumeIdentity {
  tagObjectSha: string;
  url: string;
  workflowRef: string;
  workflowSha: string;
}

export function validateOpenClawNpmResumeRun(
  input: OpenClawNpmResumeValidationInput,
): OpenClawNpmResumeIdentity;

export function resolveOpenClawNpmResumeRun(options: {
  repo: string;
  runId: string;
  runGh?: (args: string[]) => string;
}): OpenClawNpmResumeIdentity;

export function main(argv?: string[]): void;
