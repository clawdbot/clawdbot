#!/usr/bin/env node
/**
 * Diffs expected and actual plugin-extension boundary inventory entries.
 */
export function diffInventory(
  expected: unknown,
  actual: unknown,
): {
  missing: unknown;
  unexpected: unknown;
};
/**
 * Entrypoint wrapper for the plugin-extension import boundary check.
 */
export function main(argv: unknown, io: unknown): Promise<1 | 0>;
/**
 * Cached inventory of src/plugins imports that cross into bundled extensions.
 */
export const collectPluginExtensionImportBoundaryInventory: () => Promise<
  Array<{
    file: string;
    line: number;
    kind: string;
    specifier: string;
    reason: string;
  }>
>;
/**
 * Cached expected plugin-extension import inventory baseline.
 */
export const readExpectedInventory: () => Promise<
  Array<{
    file: string;
    line: number;
    kind: string;
    specifier: string;
    reason: string;
  }>
>;
