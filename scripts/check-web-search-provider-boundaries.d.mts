#!/usr/bin/env node
/**
 * Collects web-search provider boundary inventory from core source files.
 */
export function collectWebSearchProviderBoundaryInventory(): Promise<
  Array<{
    file: string;
    line: number;
    provider: string;
    reason: string;
  }>
>;
/**
 * Reads the expected web-search provider boundary inventory baseline.
 */
export function readExpectedInventory(): Promise<
  Array<{
    file: string;
    line: number;
    provider: string;
    reason: string;
  }>
>;
/**
 * Diffs expected and actual web-search provider boundary inventory entries.
 */
export function diffInventory(
  expected: unknown,
  actual: unknown,
): {
  missing: unknown;
  unexpected: unknown;
};
/**
 * Entrypoint wrapper for the web-search provider boundary check.
 */
export function main(argv: unknown, io: unknown): Promise<1 | 0>;
