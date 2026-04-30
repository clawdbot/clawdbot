import type { QaProviderMode } from "./model-selection.js";

export type QaSuiteSummaryScenario = {
  name: string;
  status: "pass" | "fail";
  steps: unknown[];
  details?: string;
};

export type QaSuiteSummaryJson = {
  scenarios: QaSuiteSummaryScenario[];
  counts: {
    total: number;
    passed: number;
    failed: number;
  };
  metrics?: {
    wallMs: number;
    gatewayProcessCpuMs?: number | null;
    gatewayCpuCoreRatio?: number | null;
    gatewayProcessRssStartBytes?: number | null;
    gatewayProcessRssEndBytes?: number | null;
    gatewayProcessRssDeltaBytes?: number | null;
  };
  run: {
    startedAt: string;
    finishedAt: string;
    providerMode: QaProviderMode;
    primaryModel: string;
    primaryProvider: string | null;
    primaryModelName: string | null;
    alternateModel: string;
    alternateProvider: string | null;
    alternateModelName: string | null;
    fastMode: boolean;
    concurrency: number;
    scenarioIds: string[] | null;
  };
};

type QaSuiteScenarioStatus = Pick<QaSuiteSummaryScenario, "status">;

export function countQaSuiteFailedScenarios(
  scenarios: ReadonlyArray<QaSuiteScenarioStatus>,
): number {
  let failed = 0;
  for (const scenario of scenarios) {
    if (scenario.status === "fail") {
      failed += 1;
    }
  }
  return failed;
}

export function readQaSuiteFailedScenarioCountFromSummary(summary: unknown): number | null {
  if (!summary || typeof summary !== "object") {
    return null;
  }
  const payload = summary as {
    counts?: {
      failed?: unknown;
    };
    scenarios?: Array<QaSuiteScenarioStatus>;
  };
  if (typeof payload.counts?.failed === "number" && Number.isFinite(payload.counts.failed)) {
    return Math.max(0, Math.floor(payload.counts.failed));
  }
  if (Array.isArray(payload.scenarios)) {
    return countQaSuiteFailedScenarios(payload.scenarios);
  }
  return null;
}
