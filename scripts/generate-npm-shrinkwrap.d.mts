#!/usr/bin/env node
/**
 * Resolves the npm command invocation used by shrinkwrap generation.
 */
export function createNpmShrinkwrapCommand(
  args: string[],
  options?: {
    comSpec?: string;
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    existsSync?: (candidate: string) => boolean;
    platform?: NodeJS.Platform;
  },
): {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  shell: boolean;
  windowsVerbatimArguments?: boolean;
};
/**
 * Reads a positive integer env override for shrinkwrap subprocess limits.
 */
export function readPositiveIntEnv(
  name: unknown,
  fallback: unknown,
  env?: NodeJS.ProcessEnv,
): number;
/**
 * Builds execFileSync options with bounded timeout and output buffer limits.
 */
export function createNpmShrinkwrapExecOptions(
  invocation: unknown,
  cwd: unknown,
  env?: NodeJS.ProcessEnv,
): {
  cwd: unknown;
  env: unknown;
  maxBuffer: number;
  shell: unknown;
  stdio: string[];
  timeout: number;
  windowsVerbatimArguments: unknown;
};
export function resolvePackageDirs(args: string[]): {
  check: unknown;
  changedPaths: string[];
  jobs: number;
  packageDirs: unknown[];
};
export function resolveShrinkwrapJobs(
  rawValue: unknown,
  env?: NodeJS.ProcessEnv,
  fallback?: number,
): number;
export function collectCurrentShrinkwrapOverrides(
  shrinkwrap: unknown,
  declaredDependencies?: Set<unknown>,
  pnpmLockPackages?: Set<unknown>,
): unknown;
export function collectOverrideViolations(
  lockfile: unknown,
  overrideRules: unknown,
): {
  path: string;
  packageName: unknown;
  actualVersion: unknown;
  expectedVersion: unknown;
  packagePath: {
    name: unknown;
    path: string;
  }[];
}[];
export function collectPnpmLockViolations(
  shrinkwrap: unknown,
  pnpmLockPackages?: Set<unknown>,
): {
  path: string;
  packageKey: string;
}[];
export function disableShrinkwrappedOverrideConflictSources(
  lockfile: unknown,
  overrideRules: unknown,
): string[];
export function exactOverrideRulesFromOverrides(overrides: unknown): unknown;
export function exactVersionFromOverrideSpec(spec: unknown): string | null;
export function normalizeOverrides(overrides: unknown): Record<string, unknown>;
export function mergeOverrides(
  packageOverrides: unknown,
  workspaceOverrides: unknown,
  pnpmLockOverrides: unknown,
): unknown;
export function applyPackageExtensionPeerMetadata(
  lockfile: unknown,
  packageExtensions?: unknown,
): unknown;
export function normalizeNpmVersionDrift<T>(lockfile: T): T;
export function packageJsonForShrinkwrap(
  packageJson: Record<string, unknown>,
  shrinkwrapOverrides: Record<string, unknown>,
): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
};
export function packageDependencyInputsChanged(packageDir: unknown, changedPaths: unknown): unknown;
export function pnpmLockOverrideVersionForVersions(versions: unknown): unknown;
export function parsePnpmPackageKey(packageKey: unknown): {
  name: string;
  version: string;
} | null;
export function parseLockPackagePath(lockPath: unknown): {
  name: unknown;
  path: string;
}[];
export function readShrinkwrapOverrides(): unknown;
export function restoreCurrentPnpmLockedPackages(
  generated: unknown,
  current: unknown,
  pnpmLockPackages?: Set<unknown>,
): unknown;
export function shouldUseLegacyPeerDepsForShrinkwrap(
  packageJson: unknown,
  packageExtensions?: unknown,
): boolean;
export function shrinkwrapPackageDirsForChangedPaths(changedPaths: string[]): string[];
