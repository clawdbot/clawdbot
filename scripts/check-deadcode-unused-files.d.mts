#!/usr/bin/env node

export type KnipUnusedFileScanResult = {
  errorCode?: string;
  errorMessage?: string;
  output: string;
  signal?: string | null;
  status: number | null;
};

/** Parses compact Knip output into unused file paths. */
export function parseKnipCompactUnusedFiles(output: string): string[];

/** Runs the production Knip unused-file scan. */
export function runKnipUnusedFiles(
  params?: Record<string, unknown>,
): Promise<KnipUnusedFileScanResult>;

/** Rejects every unused file reported by Knip. */
export function checkUnusedFiles(output: string): {
  files: string[];
  message: string;
  ok: boolean;
};

/** Validates both Knip process completion and the unused-file report. */
export function checkKnipUnusedFileScanResult(result: KnipUnusedFileScanResult): {
  failureReason: string;
  message: string;
  ok: boolean;
};

/** Maximum buffered Knip output retained for diagnostics. */
export const KNIP_MAX_BUFFER_BYTES: number;
