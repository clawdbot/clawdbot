#!/usr/bin/env node
/**
 * Parses compact knip output into unused file paths.
 */
export function parseKnipCompactUnusedFiles(output: unknown): unknown[];
/**
 * Compares detected unused files against the checked-in allowlist.
 */
export function compareUnusedFilesToAllowlist(
  actualFiles: unknown,
  allowlistFiles: unknown,
  optionalAllowlistFiles?: unknown[],
): {
  actual: unknown[];
  allowed: unknown[];
  unexpected: unknown[];
  stale: unknown[];
  duplicateAllowedCount: number;
  allowlistIsSorted: boolean;
};
/**
 * Runs knip and returns parsed unused-file results.
 */
export function runKnipUnusedFiles(params?: Record<string, unknown>): Promise<unknown>;
/**
 * Checks detected unused files against the current allowlist.
 */
export function checkUnusedFiles(
  output: unknown,
  allowlistFiles?: string[],
  optionalAllowlistFiles?: string[],
): {
  ok: boolean;
  comparison: {
    actual: unknown[];
    allowed: unknown[];
    unexpected: unknown[];
    stale: unknown[];
    duplicateAllowedCount: number;
    allowlistIsSorted: boolean;
  };
  message: string;
};
/**
 * Maximum buffered knip output retained for diagnostics.
 */
export const KNIP_MAX_BUFFER_BYTES: number;
