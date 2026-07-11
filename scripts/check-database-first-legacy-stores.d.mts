#!/usr/bin/env node
export function collectDatabaseFirstLegacyStoreSourceFiles(
  sourceRoots: string[],
): Promise<string[]>;
/**
 * Finds database-first legacy-store violations in one TypeScript/JavaScript source file.
 */
export function collectDatabaseFirstLegacyStoreViolations(
  content: string,
  relativePath?: string,
  scanOptions?: Record<string, unknown>,
): {
  kind: string;
  line: number;
}[];
/**
 * Runs the database-first legacy-store guard.
 */
export function main(): Promise<void>;
