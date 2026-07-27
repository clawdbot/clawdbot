import type { RuntimeId } from "./runtime-parity.js";

type QaRuntimeWallClockMetrics = {
  totalWallClockMs: number | null;
  p50WallClockMs: number | null;
  p90WallClockMs: number | null;
};

type QaRuntimeSpeedComparison = {
  fasterRuntime: RuntimeId | "tie" | null;
  speedupPercent: number | null;
};

export type QaRuntimeTiming = QaRuntimeSpeedComparison & {
  openclaw: QaRuntimeWallClockMetrics;
  codex: QaRuntimeWallClockMetrics;
};

export function compareRuntimeWallClockMs(
  openclawWallClockMs: number | null,
  codexWallClockMs: number | null,
): QaRuntimeSpeedComparison {
  if (openclawWallClockMs === null || codexWallClockMs === null) {
    return { fasterRuntime: null, speedupPercent: null };
  }
  if (openclawWallClockMs === codexWallClockMs) {
    return { fasterRuntime: "tie", speedupPercent: 0 };
  }
  const fasterRuntime = openclawWallClockMs < codexWallClockMs ? "openclaw" : "codex";
  const fasterWallClockMs = Math.min(openclawWallClockMs, codexWallClockMs);
  const slowerWallClockMs = Math.max(openclawWallClockMs, codexWallClockMs);
  return {
    fasterRuntime,
    speedupPercent:
      fasterWallClockMs === 0
        ? null
        : ((slowerWallClockMs - fasterWallClockMs) / fasterWallClockMs) * 100,
  };
}

function summarizeRuntimeWallClock(values: number[]): QaRuntimeWallClockMetrics {
  if (values.length === 0) {
    return { totalWallClockMs: null, p50WallClockMs: null, p90WallClockMs: null };
  }
  const sorted = values.toSorted((left, right) => left - right);
  const percentile = (value: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((value / 100) * sorted.length) - 1)] ?? null;
  return {
    totalWallClockMs: sorted.reduce((total, value) => total + value, 0),
    p50WallClockMs: percentile(50),
    p90WallClockMs: percentile(90),
  };
}

export function summarizeRuntimeParityTiming(
  scenarios: readonly {
    openclawWallClockMs: number | null;
    codexWallClockMs: number | null;
  }[],
): QaRuntimeTiming {
  const openclaw = summarizeRuntimeWallClock(
    scenarios.flatMap(({ openclawWallClockMs }) =>
      openclawWallClockMs === null ? [] : [openclawWallClockMs],
    ),
  );
  const codex = summarizeRuntimeWallClock(
    scenarios.flatMap(({ codexWallClockMs }) =>
      codexWallClockMs === null ? [] : [codexWallClockMs],
    ),
  );
  const pairedTimingCaptures = scenarios.flatMap(({ openclawWallClockMs, codexWallClockMs }) =>
    openclawWallClockMs === null || codexWallClockMs === null
      ? []
      : [{ openclawWallClockMs, codexWallClockMs }],
  );
  return {
    openclaw,
    codex,
    ...compareRuntimeWallClockMs(
      pairedTimingCaptures.length > 0
        ? pairedTimingCaptures.reduce((total, capture) => total + capture.openclawWallClockMs, 0)
        : null,
      pairedTimingCaptures.length > 0
        ? pairedTimingCaptures.reduce((total, capture) => total + capture.codexWallClockMs, 0)
        : null,
    ),
  };
}

export function formatRuntimeWallClockMs(value: number | null): string {
  return value === null ? "N/A" : `${value} ms`;
}

export function formatRuntimeSpeedComparison(comparison: QaRuntimeSpeedComparison): string {
  if (comparison.fasterRuntime === null || comparison.speedupPercent === null) {
    return "N/A";
  }
  if (comparison.fasterRuntime === "tie") {
    return "tie";
  }
  return `${comparison.fasterRuntime} ${comparison.speedupPercent.toFixed(1)}% faster`;
}
