#!/usr/bin/env node
/**
 * Returns one-based line numbers containing merge conflict markers.
 */
export function findConflictMarkerLines(content: string): number[];
/**
 * Scans a list of files for merge conflict markers, skipping binary content.
 * Intended for direct/small-scale use; the tracked-files path uses git grep
 * directly to avoid reading large files into memory.
 */
export function findConflictMarkersInFiles(
  filePaths: string[],
  readFile?: (path: string) => string | Buffer,
): {
  filePath: string;
  lines: number[];
}[];
/**
 * Uses git grep to find exact conflict-marker matches in tracked files.
 */
export function findConflictMarkersInTrackedFiles(
  cwd?: string,
  run?: typeof import("node:child_process").spawnSync,
): {
  filePath: string;
  lines: number[];
}[];
/**
 * Runs the merge conflict marker check.
 */
export function main(): Promise<void>;
