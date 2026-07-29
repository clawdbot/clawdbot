#!/usr/bin/env node
/**
 * Creates a structured dependency diff report from base/head payloads.
 */
export function createDependencyChangesReport({
  basePayload,
  headPayload,
  dependencyFileChanges,
  baseLabel,
  headLabel,
  generatedAt,
}: {
  basePayload: unknown;
  headPayload: unknown;
  dependencyFileChanges?:
    | Array<{ status: string; path: string; oldPath: string | null }>
    | undefined;
  baseLabel?: string | undefined;
  headLabel?: string | undefined;
  generatedAt?: string | undefined;
}): {
  generatedAt: string;
  baseLabel: string;
  headLabel: string;
  summary: {
    basePackages: number;
    headPackages: number;
    addedPackages: number;
    removedPackages: number;
    changedPackages: number;
    dependencyFileChanges: number;
  };
  dependencyFileChanges: unknown[];
  addedPackages: {
    packageName: string;
    versions: unknown[];
  }[];
  removedPackages: {
    packageName: string;
    versions: unknown[];
  }[];
  changedPackages: {
    packageName: string;
    addedVersions: unknown[];
    removedVersions: unknown[];
  }[];
};
/**
 * Reports whether a path is a dependency-related file.
 */
export function isDependencyFile(filePath: unknown): boolean;
/**
 * Returns git pathspecs used for dependency diff collection.
 */
export function dependencyDiffPathspecs(): string[];
export function parseArgs(argv: string[]):
  | {
      rootDir: string;
      baseRef: string;
      baseLockfile: null;
      headLockfile: string;
      jsonPath: string | null;
      markdownPath: string | null;
    }
  | {
      rootDir: string;
      baseRef: null;
      baseLockfile: string;
      headLockfile: string;
      jsonPath: string | null;
      markdownPath: string | null;
    };
/**
 * Runs the dependency changes report CLI.
 */
export function main(argv?: string[]): Promise<number>;
