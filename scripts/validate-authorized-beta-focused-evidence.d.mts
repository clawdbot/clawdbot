export type AuthorizedBetaFocusedPolicy = {
  schema: string;
  mode: string;
  releaseTag: string;
  releaseVersion: string;
  baseCandidateSha: string;
  candidateSha: string;
  reviewedHeadSha: string;
  candidateTreeSha: string;
  baseTreeSha: string;
  packageProjectionSha256: string;
  eligibilityPlanDigest: string;
  historicalToolingSha: string;
  historicalToolingRef: string;
  historicalFrv: {
    runId: string;
    runAttempt: number;
    workflowPath: string;
    workflowRef: string;
    targetSha: string;
    ciRunId: string;
    ciFailedJobId: string;
    ciAggregateJobId: string;
    pluginRunId: string;
    pluginFailedJobId: string;
    pluginAggregateJobId: string;
    releaseChecksRunId: string;
    releaseChecksVerifierJobId: string;
    performanceRunId: string;
    performanceFailedJobId: string;
  };
  focusedProof: {
    ciRunId: string;
    ciTargetLogJobId: string;
    ciSuccessJobId: string;
    pluginRunId: string;
    pluginTargetLogJobId: string;
    pluginSuccessJobId: string;
  };
  changedPaths: Array<{
    path: string;
    status: string;
    added: number;
    deleted: number;
  }>;
  inventory: {
    npmCount: number;
    npmNamesSha256: string;
    clawHubCount: number;
    clawHubNamesSha256: string;
    trustedPublisherCount: number;
    trustedPublisherNamesSha256: string;
    bootstrapCount: number;
    bootstrapNamesSha256: string;
    missingTrustedPublisherCount: number;
  };
};

export type AuthorizedBetaFocusedProducerIdentity = {
  repository: string;
  runId: string;
  runAttempt: number;
  workflowPath: string;
  workflowFullRef: string;
  workflowRef: string;
  workflowSha: string;
};

export type AuthorizedBetaFocusedEvidence = {
  schema: "openclaw.authorized-beta-focused-evidence.v1";
  mode: "authorized-beta-focused-v1";
  policySha256: string;
  releaseTag: string;
  candidate: {
    sha: string;
    parentSha: string;
    treeSha: string;
    packageProjectionSha256: string;
    changedPaths: AuthorizedBetaFocusedPolicy["changedPaths"];
  };
  producer: AuthorizedBetaFocusedProducerIdentity;
  historical: {
    frvRunId: string;
    frvRunAttempt: number;
    releaseChecksRunId: string;
    performanceRunId: string;
  };
  focused: {
    ciRunId: string;
    ciJobId: string;
    pluginRunId: string;
    pluginJobId: string;
    reviewedHeadSha: string;
  };
  inventory: {
    eligibilityPlanDigest: string;
    npmCount: number;
    npmNamesSha256: string;
    clawHubCount: number;
    clawHubNamesSha256: string;
    trustedPublisherCount: number;
    trustedPublisherNamesSha256: string;
    bootstrapCount: number;
    bootstrapNamesSha256: string;
    missingTrustedPublisherCount: number;
  };
};

export declare function readAuthorizedBetaFocusedPolicy(): AuthorizedBetaFocusedPolicy;
export declare function digestAuthorizedBetaFocusedPolicy(
  policy: AuthorizedBetaFocusedPolicy,
): string;
export declare function assertAuthorizedEligibilityPlanDigest(
  plan: unknown,
  expectedDigest: string,
): Promise<string>;
export declare function digestAuthorizedPackageNames(names: string[]): string;
export declare function assertAuthorizedBetaFocusedCandidate(
  policy: AuthorizedBetaFocusedPolicy,
  candidateRoot: string,
): void;
export declare function validateAuthorizedBetaFocusedArtifactShape(
  evidence: AuthorizedBetaFocusedEvidence,
  policy: AuthorizedBetaFocusedPolicy,
  producer: AuthorizedBetaFocusedProducerIdentity,
  expectedInventory: AuthorizedBetaFocusedEvidence["inventory"],
): void;
