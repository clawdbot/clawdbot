export function evaluateToleratedPartialKovaReport(report: unknown):
  | {
      ok: boolean;
      reason?: undefined;
    }
  | {
      ok: boolean;
      reason: string;
    };
export function evaluateToleratedProfiledKovaReport(report: unknown):
  | {
      ok: boolean;
      reason?: undefined;
    }
  | {
      ok: boolean;
      reason: string;
    };
export function evaluateToleratedKovaReport(report: unknown):
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
