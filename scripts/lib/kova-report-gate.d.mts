export interface KovaReportGateOptions {
  requireInstrumentedPerformanceContract?: boolean;
}

export function evaluateToleratedPartialKovaReport(
  report: unknown,
  options?: KovaReportGateOptions,
):
  | {
      ok: boolean;
      reason?: undefined;
    }
  | {
      ok: boolean;
      reason: string;
    };
export function evaluateToleratedProfiledKovaReport(
  report: unknown,
  options?: KovaReportGateOptions,
):
  | {
      ok: boolean;
      reason?: undefined;
    }
  | {
      ok: boolean;
      reason: string;
    };
export function evaluateToleratedKovaReport(
  report: unknown,
  options?: KovaReportGateOptions,
):
  | {
      ok: boolean;
      classification: string;
      reason?: undefined;
    }
  | {
      ok: boolean;
      reason: string;
      classification?: undefined;
    };
