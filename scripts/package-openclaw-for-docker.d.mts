#!/usr/bin/env node
export function parseArgs(argv: unknown): {
  allowUnreleasedChangelog: boolean;
  outputDir: string;
  outputName: string;
  packJson: string;
  pnpmPack: boolean;
  skipBuild: boolean;
  sourceDir: string;
};
export function buildPackageArtifacts(
  sourceDir: unknown,
  options?: Record<string, unknown>,
): Promise<void>;
export function prepareBundledAiRuntimePackage(
  sourceDir: string,
  outputDir: string,
  runCaptureImpl?: (
    command: string,
    args: string[],
    cwd: string,
    options?: Record<string, unknown>,
  ) => Promise<string>,
  options?: Record<string, unknown>,
): Promise<() => Promise<void>>;
export function packOpenClawPackageForDocker(
  sourceDir: unknown,
  outputDir: unknown,
  options?: Record<string, unknown>,
): Promise<string>;
export function writePackageInventoryForDocker(
  sourceDir: string,
  runImpl?: (
    command: string,
    args: string[],
    cwd: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<void>;
export function runCommandForTest(
  command: unknown,
  args: unknown,
  cwd: unknown,
  options?: Record<string, unknown>,
): Promise<unknown>;
