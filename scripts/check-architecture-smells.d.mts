#!/usr/bin/env node
/**
 * Collects architecture smell findings from the configured source roots.
 */
export function collectArchitectureSmells(): Promise<
  Array<{
    category: string;
    file: string;
    line: number;
    kind: string;
    specifier: string;
    reason: string;
  }>
>;
/**
 * Runs the architecture smell check and writes human/JSON output.
 */
export function main(argv: unknown, io: unknown): Promise<number>;
