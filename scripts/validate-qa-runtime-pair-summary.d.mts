#!/usr/bin/env node
export function parseArgs(argv: string[]):
  | {
      summaryPath: string;
      reportSummaryPath?: string;
      reportMarkdownPath?: string;
      requireExplicitGap: boolean;
      targetSha?: string;
      lane?: string;
    }
  | undefined;
export function validateQaRuntimePairSummary(
  summary: unknown,
  options?: { requireExplicitGap?: boolean; targetSha?: string; lane?: string },
): {
  total: number;
  passed: number;
  failed: 0;
  skipped: number;
};
export function validateQaRuntimePairReport(
  summary: unknown,
  reportSummary: unknown,
  reportMarkdown: unknown,
  options?: { requireExplicitGap?: boolean; targetSha?: string; lane?: string },
): {
  total: number;
  passed: number;
  failed: 0;
  skipped: number;
};
