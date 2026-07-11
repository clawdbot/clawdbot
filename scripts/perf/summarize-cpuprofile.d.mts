#!/usr/bin/env node
export function usage(): string;
export function shouldPrintHelp(argv: unknown): boolean;
/**
 * Parses CPU profile file paths and --limit.
 */
export function parseArgs(argv: unknown): {
  files: unknown[];
  limit: number;
};
export function summarizeProfile(file: unknown, limit: unknown): void;
