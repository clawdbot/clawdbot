#!/usr/bin/env node
/**
 * Collects dependency pin violations for the current workspace.
 */
export function collectDependencyPinViolations(cwd?: string): unknown[];
/**
 * Runs the dependency pin check.
 */
export function main(): Promise<void>;
