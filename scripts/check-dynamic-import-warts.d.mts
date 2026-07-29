#!/usr/bin/env node
/**
 * Finds dynamic import advisories in a single source file.
 */
export function findDynamicImportAdvisories(content: unknown, fileName?: string): unknown[];
/**
 * Runs the dynamic import advisory check.
 */
export function main(argv?: string[]): Promise<void>;
