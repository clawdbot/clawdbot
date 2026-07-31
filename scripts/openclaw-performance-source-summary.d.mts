#!/usr/bin/env node
export function parseArgs(argv: string[]): {
  baselineSourceDir: string | null;
  sourceDir: string;
  output: string | null;
};
export function buildMarkdown(sourceDir: unknown, baselineSourceDir: unknown): string;
