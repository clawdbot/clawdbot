#!/usr/bin/env node
/**
 * Collects static and simple constant-backed package specifiers from source text.
 */
export function collectModuleSpecifiers(source: unknown): Set<unknown>;
/**
 * Classifies whether a root dependency is core-owned, shared, or extension-local.
 */
export function classifyRootDependencyOwnership(record: unknown): {
  category: string;
  recommendation: string;
};
/**
 * Builds dependency ownership records from root package.json and scanned imports.
 */
export function collectRootDependencyOwnershipAudit(params?: Record<string, unknown>): {
  depName: string;
  spec: unknown;
  sections: unknown[];
  fileCount: number;
  sampleFiles: unknown[];
  declaredInExtensions: string[];
  internalizedBundledRuntimeOwners: string[];
  category: string;
  recommendation: string;
}[];
/**
 * Returns actionable errors for dependencies that should not remain root-owned.
 */
export function collectRootDependencyOwnershipCheckErrors(records: unknown): unknown;
