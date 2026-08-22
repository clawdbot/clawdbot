import "./diagnostic.js";

type DiagnosticTestApi = {
  resetDiagnosticStateForTest(): void;
  resolveStuckSessionAbortMs(stuckSessionWarnMs: number): number;
  resolveStuckSessionWarnMs(): number;
};

function getTestApi(): DiagnosticTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.diagnosticTestApi")
  ] as DiagnosticTestApi;
}

export function resetDiagnosticStateForTest(): void {
  getTestApi().resetDiagnosticStateForTest();
}

export function resolveStuckSessionAbortMs(stuckSessionWarnMs: number): number {
  return getTestApi().resolveStuckSessionAbortMs(stuckSessionWarnMs);
}

export function resolveStuckSessionWarnMs(): number {
  return getTestApi().resolveStuckSessionWarnMs();
}
