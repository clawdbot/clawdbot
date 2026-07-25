export type GroupedCounter = {
  configs: string[];
  durationMs: number;
  fileCount: number;
  key: string;
  testCount: number;
};

export type GroupedFile = {
  config: string;
  durationMs: number;
  file: string;
  group: string;
  testCount: number;
};

export type GroupedTestReport = {
  configs: GroupedCounter[];
  generatedAt: string;
  groupBy: string;
  groups: GroupedCounter[];
  slowTests: Array<{
    config: string;
    durationMs: number;
    file: string;
    fullName: string;
    status: string;
  }>;
  topFiles: GroupedFile[];
  totals: { durationMs: number; fileCount: number; testCount: number };
};

export type GroupedTestComparison = {
  files: Array<
    Record<string, unknown> & { file: string; status: string; delta: Record<string, number> }
  >;
  groups: Array<Record<string, unknown> & { key: string; delta: Record<string, number> }>;
  runs: Array<Record<string, unknown> & { key: string; delta: Record<string, number> }>;
  totals: { delta: { durationMs: number; fileCount: number; testCount: number } };
};

export function formatBytesAsMb(valueBytes: number | null | undefined): string;
export function normalizeConfigLabel(config: string): string;
export function resolveTestArea(file: string): string;
export function resolveGroupKey(file: string, mode?: string): string;
export function buildGroupedTestReport(params: {
  groupBy: string;
  maxTestMs?: number;
  reports: Array<{ config: string; report: unknown }>;
}): GroupedTestReport;
export function buildGroupedTestComparison(params: {
  afterPath?: string;
  beforePath?: string;
  after: Record<string, unknown>;
  before: Record<string, unknown>;
}): GroupedTestComparison;
export function renderGroupedTestComparison(
  comparison: GroupedTestComparison,
  options?: { limit?: number; topFiles?: number },
): string;
export function renderGroupedTestReport(
  report: GroupedTestReport,
  options?: { limit?: number; topFiles?: number },
): string;
