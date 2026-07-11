#!/usr/bin/env node
/**
 * Returns one-based line numbers containing merge conflict markers.
 */
export function findConflictMarkerLines(content: unknown): unknown[];
/**
 * Lists tracked files in the repository.
 */
export function listTrackedFiles(cwd?: string): string[];
/**
 * Scans files for merge conflict markers, skipping binary content.
 */
export function findConflictMarkersInFiles(
  filePaths: unknown,
  readFile?: typeof fs.readFileSync,
): {
  filePath: unknown;
  lines: unknown[];
}[];
/**
 * Finds merge conflict markers in tracked repository files.
 */
export function findConflictMarkersInTrackedFiles(cwd?: string): {
  filePath: unknown;
  lines: unknown[];
}[];
/**
 * Runs the merge conflict marker check.
 */
export function main(): Promise<void>;
import fs from "node:fs";
