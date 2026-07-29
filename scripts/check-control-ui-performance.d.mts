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

export type ControlUiStartupBudgetBaseline = {
  startupJsGzipBytes: number;
  reason: string;
  updatedAt: string;
};

export type ControlUiPerformanceBudgetViolation = {
  metric: string;
  actual: number;
  limit: number;
  unit: "count" | "bytes";
  baseline?: number;
  tolerance?: number;
};

export const CONTROL_UI_PERFORMANCE_BUDGETS: Readonly<ControlUiPerformanceBudgets>;
export const CONTROL_UI_STARTUP_JS_GZIP_TOLERANCE_BYTES: 1024;
export function extractControlUiStartupAssetPaths(html: string): string[];
export function collectControlUiPerformanceMetrics(distDir: string): ControlUiPerformanceMetrics;
export function evaluateControlUiPerformanceBudgets(
  metrics: ControlUiPerformanceMetrics,
  budgets?: Readonly<ControlUiPerformanceBudgets>,
  startupBudgetBaseline?: Readonly<ControlUiStartupBudgetBaseline>,
  startupJsTolerance?: number,
): ControlUiPerformanceBudgetViolation[];
export function formatControlUiPerformanceBytes(bytes: number): string;
export function formatControlUiPerformanceReport(
  metrics: ControlUiPerformanceMetrics,
  budgets?: Readonly<ControlUiPerformanceBudgets>,
  startupBudgetBaseline?: Readonly<ControlUiStartupBudgetBaseline>,
  startupJsTolerance?: number,
): string;
export function runControlUiPerformanceCheck(
  distDir: string,
  budgets?: Readonly<ControlUiPerformanceBudgets>,
  baselinePath?: string,
): {
  metrics: ControlUiPerformanceMetrics;
  budgets: Readonly<ControlUiPerformanceBudgets>;
  startupBudgetBaseline: ControlUiStartupBudgetBaseline;
  startupJsTolerance: number;
  violations: ControlUiPerformanceBudgetViolation[];
  report: string;
};
