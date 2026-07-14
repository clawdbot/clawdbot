export type ControlUiAssetMetrics = {
  file: string;
  type: "js" | "css";
  rawBytes: number;
  gzipBytes: number;
  brotliBytes: number;
};

export type ControlUiAssetSummary = {
  requests: number;
  rawBytes: number;
  gzipBytes: number;
  brotliBytes: number;
};

export type ControlUiPerformanceMetrics = {
  schemaVersion: 1;
  startup: {
    js: ControlUiAssetSummary;
    css: ControlUiAssetSummary;
    assets: ControlUiAssetMetrics[];
  };
  total: { js: ControlUiAssetSummary; css: ControlUiAssetSummary };
  largest: { js: ControlUiAssetMetrics; css: ControlUiAssetMetrics };
};

export type ControlUiPerformanceBudgets = {
  startupJsRequests: number;
  startupCssRequests: number;
  startupJsGzipBytes: number;
  startupCssGzipBytes: number;
  largestJsGzipBytes: number;
  largestCssGzipBytes: number;
};

export type ControlUiPerformanceBudgetViolation = {
  metric: string;
  actual: number;
  limit: number;
  unit: "count" | "bytes";
};

export const CONTROL_UI_PERFORMANCE_BUDGETS: Readonly<ControlUiPerformanceBudgets>;
export function extractControlUiStartupAssetPaths(html: string): string[];
export function collectControlUiPerformanceMetrics(distDir: string): ControlUiPerformanceMetrics;
export function evaluateControlUiPerformanceBudgets(
  metrics: ControlUiPerformanceMetrics,
  budgets?: Readonly<ControlUiPerformanceBudgets>,
): ControlUiPerformanceBudgetViolation[];
export function formatControlUiPerformanceBytes(bytes: number): string;
export function formatControlUiPerformanceReport(
  metrics: ControlUiPerformanceMetrics,
  budgets?: Readonly<ControlUiPerformanceBudgets>,
): string;
export function runControlUiPerformanceCheck(
  distDir: string,
  budgets?: Readonly<ControlUiPerformanceBudgets>,
): {
  metrics: ControlUiPerformanceMetrics;
  budgets: Readonly<ControlUiPerformanceBudgets>;
  violations: ControlUiPerformanceBudgetViolation[];
  report: string;
};
