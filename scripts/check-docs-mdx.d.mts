#!/usr/bin/env node
/**
 * Parses docs MDX check arguments.
 */
export function parseArgs(argv: unknown): {
  roots: unknown[];
  jsonOut: string;
  maxErrors: number;
};
