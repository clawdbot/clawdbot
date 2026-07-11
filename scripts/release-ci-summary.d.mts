#!/usr/bin/env node
export function validateParentRunBinding(
  parentView: unknown,
  parentRest: unknown,
  expectedRunId: unknown,
): unknown;
export function expectedChildDispatches(
  parentRunId: unknown,
  parentRunAttempt: unknown,
  parentWorkflowRef: unknown,
): {
  displayTitle: string;
  headBranch: string;
  manifestKey: string;
  name: string;
  parentJobName: string;
  suffix: string;
  trustedRef: string;
  workflow: string;
}[];
export function requiredChildKeysForRerunGroup(rerunGroup: unknown): Set<string>;
export function expectedSelectedChildDispatches(
  parentRunId: unknown,
  parentRunAttempt: unknown,
  parentWorkflowRef: unknown,
  selectedKeys: unknown,
): {
  displayTitle: string;
  headBranch: string;
  manifestKey: string;
  name: string;
  parentJobName: string;
  suffix: string;
  trustedRef: string;
  workflow: string;
}[];
export function selectExactChildRun(
  runs: unknown,
  expectedDisplayTitle: unknown,
  expectedHeadBranch: unknown,
): unknown;
export function selectExactChildRunFromPages(
  runPages: unknown,
  expectedDisplayTitle: unknown,
  expectedHeadBranch: unknown,
): unknown;
export function validateParentManifest(
  value: unknown,
  expected: unknown,
): {
  childRunIds: {
    normalCi: string;
    npmTelegram: string;
    pluginPrerelease: string;
    productPerformance: string;
    releaseChecks: string;
  };
  controls: Record<string, unknown>;
  evidenceReuse:
    | {
        changedPaths: string[];
        evidenceSha: string;
        policy: string;
        runId: string;
        selectedRunId: string;
      }
    | undefined;
  releaseProfile: string;
  rerunGroup: string;
  runAttempt: number;
  runId: string;
  runReleaseSoak: string;
  targetRef: string;
  targetSha: string;
  validationInputs: Record<string, unknown>;
  version: unknown;
  workflowFullRef: string | undefined;
  workflowSha: string | undefined;
  workflowRef: unknown;
  workflowRefType: string | undefined;
};
export function validateEvidenceReuseChain(
  currentManifest: unknown,
  selectedManifest: unknown,
  rootManifest: unknown,
): unknown;
export function selectedChildKeys(parentJobs: unknown): Set<string>;
export function manifestChildEntries<Child extends { manifestKey: string; name: string }>(
  manifest: { childRunIds: Record<string, string> },
  children: Child[],
  selectedKeys: Set<string>,
): Array<{ child: Child; runId: string }>;
export function resolveManifestChildOriginAttempt(
  run: unknown,
  child: unknown,
  parentManifest: unknown,
  parentJobs: unknown,
): unknown;
export function selectManifestParentJob(
  parentJobs: unknown,
  child: unknown,
  parentManifest: unknown,
  originAttempt: unknown,
): unknown;
export function validateManifestChildRun(
  run: unknown,
  child: unknown,
  runId: unknown,
  parentManifest: unknown,
  parentJobs: unknown,
  selectedParentJobLog: unknown,
  repository?: string,
): unknown;
export function validatePerformanceArtifactOnlyJobs(jobs: unknown, runAttempt: unknown): unknown;
export function validateManifestArtifactIdentity(
  artifact: unknown,
  {
    artifactDigest,
    artifactId,
    runAttempt,
    runId,
  }: {
    artifactDigest: unknown;
    artifactId: unknown;
    runAttempt: unknown;
    runId: unknown;
  },
): unknown;
export function selectManifestArtifact(
  artifacts: unknown,
  runId: unknown,
  runAttempt: unknown,
): unknown;
export function validateManifestArtifactCompatibility(
  artifact: unknown,
  manifest: unknown,
  runId: unknown,
  runAttempt: unknown,
): unknown;
export function readManifestArtifactArchive(archivePath: unknown, expectedDigest: unknown): unknown;
export function createReleaseEvidenceClient(repository?: string): {
  compareCommits(base: unknown, head: unknown): unknown;
  getJobLog(jobId: unknown): string;
  getParentJobs(runId: unknown): unknown[];
  getRun(runId: unknown): unknown;
  getRunView(runId: unknown): unknown;
  loadManifest(
    runId: unknown,
    runAttempt: unknown,
    manifestPath: unknown,
  ):
    | {
        artifact: unknown;
        manifest: unknown;
      }
    | undefined;
};
export function validateTrustedProducerIdentity(
  evidence: unknown,
  client: unknown,
  verifier: unknown,
  trustedWorkflowRef: unknown,
): {
  producerOnTrustedMainLineage: boolean;
  workflowFullRef: string;
  workflowQualifiedPath: string;
  workflowRefProof: string;
  workflowRefType: string;
  workflowRunPath: string;
};
export function resolveVerifierIdentity(
  sourceSha: unknown,
  verifierSourceContent: unknown,
  repositoryRoot?: string,
): {
  schemaVersion: number;
  script: string;
  scriptSha256: string;
  sourceSha: unknown;
};
export type ReleaseRunEvidence = {
  children: Array<Record<string, unknown>>;
  directRoot: boolean;
  evidenceReuse: Record<string, unknown> | null;
  producerOnTrustedMainLineage: boolean;
  releaseProfile: string;
  repository: string;
  rerunGroup: string;
  root: Record<string, unknown> & {
    artifact: Record<string, unknown>;
    targetSha: string;
    workflowSha: string;
  };
  runReleaseSoak: boolean;
  schema: string;
  trustedWorkflowFullRef: string;
  trustedWorkflowRef: string;
  valid: boolean;
  verifier: { schemaVersion: number; sourceSha: string };
};
export function validateReleaseRunEvidence(
  {
    manifestPath,
    repository,
    runId,
    trustedWorkflowRef,
    verifierSourceContent,
    verifierSourceSha,
  }: {
    manifestPath?: string;
    repository?: string | undefined;
    runId: string;
    trustedWorkflowRef?: string | undefined;
    verifierSourceContent?: string | Uint8Array;
    verifierSourceSha: string;
  },
  client?: unknown,
): ReleaseRunEvidence;
export function parseReleaseCiSummaryArgs(argv: string[]): {
  intervalMs: number;
  json: boolean;
  manifestPath: string | undefined;
  repository: string;
  runId: string;
  trustedWorkflowRef: string;
  validate: boolean;
  verifierSourceFile: string | undefined;
  verifierSourceSha: string | undefined;
  watch: boolean;
};
export function releaseCiWatchFingerprint(parent: unknown): string;
export function watchReleaseCiRun(
  options: unknown,
  overrides?: Record<string, unknown>,
): Promise<void>;
