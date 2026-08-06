#!/usr/bin/env node
/**
 * Resolves the compile worker count from CLI/env/default settings.
 */
export function resolveCompileConcurrency(
  env?: NodeJS.ProcessEnv,
  availableParallelism?: number,
): number;
/**
 * Appends child-process output while preserving only the diagnostic tail.
 */
export function appendBoundedStepOutput(
  buffer: unknown,
  chunk: unknown,
  maxChars?: number,
): {
  text: string;
  truncatedChars: unknown;
};
/**
 * Formats the successful boundary compile summary.
 */
export function formatBoundaryCheckSuccessSummary(params?: Record<string, unknown>): string;
/**
 * Formats skipped compile progress for fresh extension canaries.
 */
export function formatSkippedCompileProgress(params?: Record<string, unknown>): string;
/**
 * Formats slow extension compile diagnostics.
 */
export function formatSlowCompileSummary(params?: Record<string, unknown>): string;
/**
 * Formats a failed boundary-check child process step.
 */
export function formatStepFailure(label: unknown, params?: Record<string, unknown>): string;
/**
 * Checks whether an extension boundary compile canary is still fresh.
 */
export function isBoundaryCompileFresh(
  extensionId: unknown,
  params?: Record<string, unknown>,
): boolean;
/**
 * Runs one node-based boundary check step with timeout and output capture.
 */
export function runNodeStepAsync(
  label: unknown,
  args: unknown,
  timeoutMs: unknown,
  params?: Record<string, unknown>,
): Promise<unknown>;
/**
 * Runs boundary check steps with bounded concurrency.
 */
export function runNodeStepsWithConcurrency(steps: unknown, concurrency: unknown): Promise<void>;
/**
 * Resolves canary artifact paths for an extension boundary compile.
 */
export function resolveCanaryArtifactPaths(
  extensionId: unknown,
  rootDir?: string,
): {
  extensionRoot: string;
  canaryPath: string;
  tsconfigPath: string;
};
/**
 * Removes canary artifacts for multiple extensions.
 */
export function cleanupCanaryArtifactsForExtensions(extensionIds: unknown, rootDir?: string): void;
/**
 * Installs signal/exit cleanup for extension canary artifacts.
 */
export function installCanaryArtifactCleanup(
  extensionIds: unknown,
  params?: Record<string, unknown>,
): () => void;
/**
 * Resolves the local lock path for extension boundary checks.
 */
export function resolveBoundaryCheckLockPath(rootDir?: string): string;
/**
 * Acquires the single-process lock for extension boundary checks.
 */
export function acquireBoundaryCheckLock(params?: Record<string, unknown>): () => void;
/**
 * Runs the extension package TypeScript boundary check.
 */
export function main(argv?: string[]): Promise<void>;
