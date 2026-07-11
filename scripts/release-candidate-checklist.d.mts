#!/usr/bin/env node
/**
 * Parses release-candidate validation options and enforces publish-scope policy.
 */
export function parseArgs(argv: unknown): {
  repo: string;
  provider: string;
  mode: string;
  releaseProfile: string;
  npmDistTag: string;
  pluginPublishScope: string;
  plugins: string;
  skipDispatch: boolean;
  skipLocalGeneratedCheck: boolean;
  skipParallels: boolean;
  skipTelegram: boolean;
  telegramProviderMode: string;
  tag: string;
  workflowRef: string;
  fullReleaseRunId: string;
  npmPreflightRunId: string;
  windowsNodeTag: string;
  windowsNodeInstallerDigests: string;
  outputDir: string;
};
export function run(command: unknown, args: unknown, options?: Record<string, unknown>): string;
export function buildReleaseCandidateState(
  options: unknown,
  {
    targetSha,
    toolingSha,
  }: {
    targetSha: unknown;
    toolingSha: unknown;
  },
): {
  version: number;
  phase: string;
  repo: unknown;
  tag: unknown;
  targetSha: unknown;
  toolingSha: unknown;
  workflowRef: unknown;
  provider: unknown;
  mode: unknown;
  releaseProfile: unknown;
  npmDistTag: unknown;
  pluginPublishScope: unknown;
  plugins: unknown;
  windowsNodeTag: unknown;
  skipParallels: unknown;
  skipTelegram: unknown;
  telegramProviderMode: unknown;
  fullReleaseRunId: unknown;
  npmPreflightRunId: unknown;
};
export function reconcileReleaseCandidateState(saved: unknown, expected: unknown): unknown;
/**
 * Calls the GitHub REST API with the gh-auth token and a bounded timeout.
 */
export function githubApi(path: unknown, options?: Record<string, unknown>): Promise<unknown>;
/**
 * Validates the immutable Windows source release contract for a stable candidate.
 */
export function validateWindowsSourceRelease(
  tag: unknown,
  options?: Record<string, unknown>,
): Promise<{
  tag: unknown;
  url: unknown;
  assets: {
    name: string;
    digest: unknown;
  }[];
}>;
export function validateCandidateCheckout({
  targetSha,
  targetHeadSha,
  targetTrackedStatus,
  toolingSha,
  trustedToolingSha,
  toolingTrackedStatus,
  workflowRef,
}: {
  targetSha: unknown;
  targetHeadSha: unknown;
  targetTrackedStatus: unknown;
  toolingSha: unknown;
  trustedToolingSha: unknown;
  toolingTrackedStatus: unknown;
  workflowRef: unknown;
}): {
  status: string;
  targetSha: unknown;
  toolingSha: unknown;
  workflowRef: unknown;
};
export function candidateCumulativeShippedPullRequests(
  changelog: string,
  label: string,
): Set<number>;
export function validateCandidateReleaseNotes({
  changelog,
  repository,
  tag,
}: {
  changelog: unknown;
  repository: unknown;
  tag: unknown;
}): {
  status: string;
  mode: string;
  characters: number;
  bytes: number;
};
export function validateCandidateChangelogProvenance({
  changelog,
  version,
  tag,
  targetSha,
  isAncestor,
  loadShippedBaseline,
}: {
  changelog: unknown;
  version: unknown;
  tag: unknown;
  targetSha: unknown;
  isAncestor?: ((ancestor: string, target: string) => boolean) | undefined;
  loadShippedBaseline?: typeof loadCandidateShippedBaseline | undefined;
}):
  | {
      status: string;
      reason: string;
      shippedBaselines: ShippedBaselineExclusion[];
      base?: undefined;
      target?: undefined;
    }
  | {
      status: string;
      base: unknown;
      target: unknown;
      shippedBaselines: ShippedBaselineExclusion[];
      reason?: undefined;
    };
/**
 * Chooses the expected artifact name, allowing one same-prefix fallback per run.
 */
export function resolveArtifactName(
  artifacts: unknown,
  preferredName: unknown,
  prefix: unknown,
): unknown;
/**
 * Extracts a GitHub Actions run id from gh workflow dispatch output.
 */
export function parseRunIdFromDispatchOutput(output: unknown): unknown;
export function requireRunIdFromDispatchOutput(output: unknown, workflowFile: unknown): unknown;
/**
 * Builds the final release publish workflow command once validation evidence is ready.
 */
export function buildPublishCommand(options: unknown): string;
export function validatePreflightManifest(manifest: unknown, params: unknown): void;
export function validateFullManifest(manifest: unknown, params: unknown): void;
export function candidateParallelsArgs(
  tarballPath: unknown,
  dependencyTarballPaths?: unknown[],
): unknown[];
export function candidateParallelsShellCommand(
  tarballPath: unknown,
  timeoutBin: unknown,
  dependencyTarballPaths?: unknown[],
): string;
declare function gitIsAncestor(ancestor: unknown, target: unknown): boolean;
declare function loadCandidateShippedBaseline(ref: unknown): {
  ref: unknown;
  pullRequests: Set<unknown>;
};
import type { ShippedBaselineExclusion } from "./render-github-release-notes.mjs";
