#!/usr/bin/env node
export function parseExtendedStableGuardBypass(value?: string): boolean;
export function validateNpmPublishBoundary(
  packageVersion: unknown,
  npmDistTag: unknown,
  {
    bypassExtendedStableGuard,
  }?: {
    bypassExtendedStableGuard?: boolean | undefined;
  },
): import("./lib/release-version.mjs").ParsedReleaseVersion;
export function validateExtendedStableNpmReleaseRequest(request: unknown):
  | {
      extendedStable: boolean;
      releaseVersion?: undefined;
      extendedStableBranch?: undefined;
      bypassExtendedStableGuard?: undefined;
    }
  | {
      extendedStable: boolean;
      releaseVersion: string;
      extendedStableBranch: string;
      bypassExtendedStableGuard: boolean;
    }
  | {
      extendedStable: boolean;
      releaseVersion: string;
      extendedStableBranch: string;
      bypassExtendedStableGuard?: undefined;
    };
export function validateExtendedStableRunIdentity({
  run,
  kind,
  npmDistTag,
  expectedBranch,
  expectedSha,
}: {
  run: unknown;
  kind: unknown;
  npmDistTag: unknown;
  expectedBranch: unknown;
  expectedSha: unknown;
}): unknown;
export function validateFullReleaseValidationManifest({
  manifest,
  npmDistTag,
  expectedWorkflowRef,
  expectedSha,
  expectedRunId,
  expectedRunAttempt,
}: {
  manifest: unknown;
  npmDistTag: unknown;
  expectedWorkflowRef: unknown;
  expectedSha: unknown;
  expectedRunId: unknown;
  expectedRunAttempt: unknown;
}): unknown;
export function parsePriorExtendedStableSelector(stdout: unknown): string;
export function capturePriorExtendedStableSelector({ query }: { query: unknown }): string;
export function verifyExtendedStableRegistryReadback({
  expectedVersion,
  query,
  sleep,
  attempts,
  delayMs,
}: {
  expectedVersion: unknown;
  query: unknown;
  sleep: unknown;
  attempts?: number | undefined;
  delayMs?: number | undefined;
}): Promise<{
  exactVersion: string;
  extendedStableSelector: string;
  attemptsUsed: number;
}>;
export function extendedStableSelectorRepairCommand(expectedVersion: unknown): string;
