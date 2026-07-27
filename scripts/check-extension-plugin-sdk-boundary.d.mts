#!/usr/bin/env node
/**
 * Reads the checked-in expected boundary inventory.
 */
export function readExpectedInventory(mode: unknown): Promise<unknown>;
/**
 * Diffs expected and actual boundary inventory entries.
 */
export function diffInventory(
  expected: unknown,
  actual: unknown,
): {
  missing: unknown;
  unexpected: unknown;
};
/**
 * Entrypoint wrapper for the extension plugin SDK boundary check.
 */
export function main(argv: unknown, io: unknown): Promise<1 | 0>;
