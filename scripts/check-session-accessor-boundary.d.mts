#!/usr/bin/env node
export function collectSessionStoreRuntimeFileBackedCompatExports(
  content: unknown,
  fileName?: string,
): Map<unknown, unknown>;
export function findSessionStoreRuntimeFileBackedCompatExportViolations(
  content: unknown,
  fileName?: string,
): {
  line: unknown;
  reason: string;
}[];
export function findSessionAccessorBoundaryViolations(
  content: unknown,
  fileName?: string,
): unknown[];
export function findReadOnlySessionAccessorViolations(
  content: unknown,
  fileName?: string,
): unknown[];
export function findEmbeddedAgentSessionTargetViolations(
  content: unknown,
  fileName?: string,
): unknown[];
export function findSessionAccessorWriteBoundaryViolations(
  content: unknown,
  fileName?: string,
): unknown[];
export function findTranscriptWriterBoundaryViolations(
  content: unknown,
  fileName?: string,
): unknown[];
export function findGatewaySessionCreateLifecycleViolations(
  content: unknown,
  fileName?: string,
): unknown[];
export function findSessionCompactManualTrimBoundaryViolations(
  content: unknown,
  fileName?: string,
): unknown[];
export function findSessionLifecycleCleanupBoundaryViolations(
  content: unknown,
  fileName?: string,
): unknown[];
export function findMemoryHostSessionCorpusBoundaryViolations(
  content: unknown,
  fileName?: string,
): unknown[];
/** Ratchet compare: counts above baseline are regressions, below are improvements. */
export function compareSessionAccessorDebt(
  currentCounts: unknown,
  baselineCounts: unknown,
): {
  regressions: {
    concern: string;
    path: string;
    currentCount: unknown;
    baselineCount: unknown;
  }[];
  improvements: {
    concern: string;
    path: string;
    currentCount: unknown;
    baselineCount: unknown;
  }[];
};
export function formatSessionAccessorDebtImprovements(improvements: unknown): unknown[];
export function main(): Promise<void>;
export const allowedSessionStoreRuntimeFileBackedCompatExports: Set<string>;
export const migratedSessionAccessorFiles: Set<string>;
export const migratedBundledPluginSessionAccessorFiles: Set<string>;
export const migratedEmbeddedAgentSessionTargetFiles: Set<string>;
export const migratedSessionAccessorWriteFiles: Set<string>;
export const migratedTranscriptWriterFiles: Set<string>;
export const migratedSessionCompactManualTrimFiles: Set<string>;
export const migratedSessionLifecycleCleanupFiles: Set<string>;
export const migratedMemoryHostSessionCorpusFiles: Set<string>;
export const readOnlyGatewaySessionAccessorFiles: Set<string>;
