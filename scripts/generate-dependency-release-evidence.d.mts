#!/usr/bin/env node
/**
 * Resolves the release tag when the release ref is a SHA or tag.
 */
export function resolveReleaseTag({
  releaseRef,
  packageVersion,
}: {
  releaseRef: unknown;
  packageVersion: unknown;
}): unknown;
/**
 * Resolves the previous reachable release tag for dependency diffs.
 */
export function resolvePreviousReleaseTag({
  rootDir,
  execFileSyncImpl,
  fetchOnMiss,
}?: {
  rootDir?: string | undefined;
  execFileSyncImpl?: ((command: string, args?: string[]) => string) | undefined;
  fetchOnMiss?: boolean | undefined;
}): string;
/**
 * Creates the dependency evidence manifest payload.
 */
export function createDependencyEvidenceManifest({
  generatedAt,
  releaseTag,
  releaseRef,
  releaseSha,
  npmDistTag,
  packageVersion,
  workflowRunId,
  workflowRunAttempt,
  dependencyChangeBaseRef,
}?: {
  generatedAt?: string | undefined;
  releaseTag?: string;
  releaseRef?: string;
  releaseSha?: string;
  npmDistTag?: string;
  packageVersion?: string;
  dependencyChangeBaseRef?: string;
  workflowRunId?: string | undefined;
  workflowRunAttempt?: string | undefined;
}): {
  schemaVersion: number;
  generatedAt: string;
  releaseTag: unknown;
  releaseRef: unknown;
  releaseSha: unknown;
  npmDistTag: unknown;
  packageName: string;
  packageVersion: unknown;
  workflowRunId: string;
  workflowRunAttempt: string;
  dependencyChangeBaseRef: unknown;
  reports: {
    name: string;
    command: string;
    policy: string;
    json: string;
    markdown: string;
  }[];
};
/**
 * Reads generated reports and collects summary counts.
 */
export function collectDependencyEvidenceSummaryCounts(evidenceDir: unknown): Promise<{
  vulnerabilityBlockers: unknown;
  vulnerabilityFindings: unknown;
  transitiveRiskSignals: unknown;
  workspaceExcludedTransitiveSignals: unknown;
  transitiveMetadataFailures: unknown;
  ownershipLockfilePackages: unknown;
  ownershipBuildRiskPackages: unknown;
  dependencyFileChanges: unknown;
  dependencyAddedPackages: unknown;
  dependencyRemovedPackages: unknown;
  dependencyChangedPackages: unknown;
}>;
/**
 * Renders the dependency evidence Markdown summary.
 */
export function renderDependencyEvidenceSummary({
  releaseTag,
  releaseSha,
  baseRef,
  counts,
}: {
  releaseTag: unknown;
  releaseSha: unknown;
  baseRef: unknown;
  counts: unknown;
}): string;
/**
 * Renders the GitHub Actions step summary for dependency evidence.
 */
export function renderDependencyEvidenceStepSummary({
  evidenceArtifactName,
  baseRef,
  counts,
}: {
  evidenceArtifactName: unknown;
  baseRef: unknown;
  counts: unknown;
}): string;
export function parseArgs(argv: string[]): {
  help?: true;
  rootDir: string;
  outputDir: string | null;
  releaseRef: string | null;
  npmDistTag: string | null;
  baseRef: string | null;
  githubOutput: string | undefined;
  githubStepSummary: string | undefined;
};
/**
 * Runs the dependency release evidence generator CLI.
 */
export function main(argv?: string[]): Promise<number>;
/**
 * Dependency evidence reports generated for release artifacts.
 */
export const DEPENDENCY_EVIDENCE_REPORTS: {
  name: string;
  command: string;
  policy: string;
  json: string;
  markdown: string;
}[];
import { execFileSync } from "node:child_process";
