#!/usr/bin/env node
/**
 * Finds `os.tmpdir()` or imported `tmpdir()` call lines in source.
 */
export function findMessagingTmpdirCallLines(content: unknown, fileName?: string): unknown[];
/**
 * Runs the messaging tmpdir guard.
 */
export function main(): Promise<void>;
/**
 * Source roots scanned for unsafe messaging tmpdir usage.
 */
export const messagingTmpdirGuardSourceRoots: string[];
