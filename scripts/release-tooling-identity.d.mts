export type ReleaseToolingIdentity = {
  fullRef: string;
  ref: string;
  route: "main" | "prevalidated-branch" | "protected-tag";
  sha: string;
};

export type ReleaseToolingIdentityInput = {
  allowPrevalidatedRef?: boolean;
  workflowFullRef: string;
  workflowRef: string;
  workflowSha: string;
};

export function resolveReleaseToolingIdentity(
  input: {
    requestedIdentityJson?: string;
    workflowContract: string;
  } & Pick<ReleaseToolingIdentityInput, "workflowFullRef" | "workflowRef" | "workflowSha">,
): Pick<ReleaseToolingIdentity, "fullRef" | "ref" | "sha">;

export function validateReleaseToolingIdentity(
  input: ReleaseToolingIdentityInput & {
    mainComparisonStatus?: unknown;
    branchRef?: unknown;
    tagRef?: unknown;
  },
): ReleaseToolingIdentity;

export function verifyReleaseToolingIdentity(
  input: ReleaseToolingIdentityInput & {
    repository: string;
    releasePublishParentStatePolicy?: "active" | "active-or-success" | "manual-recovery";
    releasePublishRunAttempt?: string;
    releasePublishRunId?: string;
    runGh?: (args: string[]) => string;
  },
): ReleaseToolingIdentity;

export function validateReleasePublishParentRun(input: {
  identity: Pick<ReleaseToolingIdentity, "fullRef" | "ref" | "sha">;
  releasePublishParentStatePolicy: "active" | "active-or-success" | "manual-recovery";
  releasePublishRunAttempt: string;
  releasePublishRunId: string;
  repository: string;
  run: unknown;
}): void;
