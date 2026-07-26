#!/usr/bin/env node
export function shouldPrintHelp(argv: unknown): boolean;
/**
 * Parses CPU profile file paths and --limit.
 */
export function parseArgs(argv: unknown): {
  files: unknown[];
  limit: number;
};
