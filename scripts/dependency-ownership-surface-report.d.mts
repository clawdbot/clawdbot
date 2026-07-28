#!/usr/bin/env node
/**
 * Extracts the package name from a pnpm lockfile package key.
 */
export function packageNameFromLockKey(lockKey: unknown): unknown;
/**
 * Collects dependency ownership and transitive surface metadata.
 */
export function collectDependencyOwnershipSurfaceReport(params?: Record<string, unknown>): {
  schemaVersion: number;
  generatedAt: string;
  target: {
    packageName: unknown;
    packageVersion: unknown;
    gitBranch: string | null;
    gitCommit: string | null;
    lockfile: string;
    ownershipMetadata: string;
  };
  summary: {
    importerCount: number;
    lockfilePackageCount: number;
    rootDirectDependencyCount: number;
    rootClosurePackageCount: number;
    rootOwnershipRecordCount: number;
    buildRiskPackageCount: number;
  };
  ownershipGaps: string[];
  staleOwnershipRecords: string[];
  ownershipWarnings: {
    name: string;
    owner: unknown;
    sourceSections: unknown[];
    message: string;
  }[];
  buildRiskPackages: {
    name: unknown;
    lockKey: string;
    requiresBuild: boolean;
    hasBin: boolean;
    platformRestricted: boolean;
  }[];
  topRootDependencyCones: {
    name: string;
    specifier: unknown;
    section: string;
    resolved: string;
    owner: unknown;
    class: unknown;
    risk: unknown;
    sourceCategory: string | null;
    sourceSections: unknown[];
    sourceFileCount: number;
    closureSize: number;
    missingSnapshotKeys: unknown[];
  }[];
  rootDependencies: {
    name: string;
    specifier: unknown;
    section: string;
    resolved: string;
    owner: unknown;
    class: unknown;
    risk: unknown;
    sourceCategory: string | null;
    sourceSections: unknown[];
    sourceFileCount: number;
    closureSize: number;
    missingSnapshotKeys: unknown[];
  }[];
  importerClosures: {
    importer: string;
    directDependencyCount: number;
    closureSize: number;
  }[];
};
/**
 * Collects policy errors from a dependency ownership surface report.
 */
export function collectDependencyOwnershipSurfaceCheckErrors(report: unknown): unknown;
/**
 * Renders a dependency ownership surface report as Markdown.
 */
export function renderDependencyOwnershipSurfaceMarkdownReport(report: unknown): string;
export function parseArgs(argv: string[]): {
  asJson: boolean;
  check: boolean;
  jsonPath: string | null;
  markdownPath: string | null;
};
