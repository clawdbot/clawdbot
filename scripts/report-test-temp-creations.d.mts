#!/usr/bin/env node
export function formatGithubWarning(finding: unknown): string;
export function collectTempCreationFindingsFromDiff(
  diffText: unknown,
  options?: Record<string, unknown>,
): (
  | {
      file: unknown;
      line: unknown;
      reason: string;
      source: string;
    }
  | {
      file: string;
      line: number;
      reason: string;
      source: unknown;
    }
)[];
export function main(argv: unknown, io: unknown): Promise<1 | 0>;
