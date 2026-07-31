#!/usr/bin/env node
export function parseArgs(argv: unknown): {
  artifactDir: string;
  githubOutput: string;
  metadata: string;
  outputDir: string;
  outputName: string;
  packageRef: string;
  packageSha256: string;
  packageSpec: string;
  packageUrl: string;
  source: string;
  trustedSourceId: string;
  trustedSourcePolicy: string;
  help?: true;
};
export function validateOpenClawPackageSpec(spec: unknown): void;
export function resolveNpmPackageCandidatePackRunner(
  packageSpec: string,
  outputDir: string,
  params?: {
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
export function signalChildProcessTree(
  child: unknown,
  signal: unknown,
  {
    platform,
    runTaskkill,
    useProcessGroup,
  }?: {
    platform?: NodeJS.Platform | undefined;
    runTaskkill?:
      | ((
          command: string,
          args: readonly string[],
          options: { stdio: "ignore" },
        ) => { error?: Error; status: number | null })
      | undefined;
    useProcessGroup?: boolean | undefined;
  },
): void;
export function readArtifactPackageCandidateMetadata(dir: unknown): Promise<unknown>;
export function loadTrustedPackageSource(
  id: unknown,
  policyPath?: string,
): Promise<{
  allowPrivateNetwork: boolean;
  auth: unknown;
  hosts: unknown[];
  id: unknown;
  pathPrefixes: string[];
  ports: number[];
  redirectHosts: unknown[];
}>;
export function downloadUrl(
  url: unknown,
  target: unknown,
  options?: Record<string, unknown>,
): Promise<void>;
export function readPackageBuildSourceSha(tarball: unknown): Promise<unknown>;
export function main(argv?: string[]): Promise<void>;
export const ARTIFACT_TARBALL_SCAN_MAX_ENTRIES: 10000;
export const OPENCLAW_PACKAGE_SPEC_RE: RegExp;
export function runCommandForTest(
  command: unknown,
  args: unknown,
  options?: Record<string, unknown>,
): Promise<unknown>;
export function assertExpectedSha256ForTest(file: unknown, expected: unknown): Promise<string>;
export function findSingleTarballForTest(dir: unknown, maxEntries?: number): Promise<string>;
export function cleanupPackageSourceWorktreeForTest(
  sourceDir: unknown,
  {
    resolveError,
    runImpl,
    consoleError,
  }?: {
    runImpl?: typeof run | undefined;
    consoleError?: ((message: string) => void) | undefined;
    resolveError?: unknown;
  },
): Promise<void>;
export function moveNewestPackedTarballForTest(
  outputDir: unknown,
  packOutput: unknown,
  outputName: unknown,
): Promise<string>;
export function cleanPackedOpenClawTarballsForTest(outputDir: unknown): Promise<void>;
declare function run(
  command: unknown,
  args: unknown,
  options?: Record<string, unknown>,
): Promise<unknown>;
