import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";
import "./doctor-health-contributions.js";
import type { HealthCheckInput, RunnableHealthCheck } from "./health-check-runner-types.js";
import type { HealthCheck } from "./health-checks.js";
import type { FlowContribution } from "./types.js";

type DoctorContributionHealthCheck =
  | (Omit<HealthCheck, "id" | "kind" | "source"> & {
      readonly id?: string;
      readonly kind?: "core";
      readonly source?: string;
    })
  | (Omit<RunnableHealthCheck, "id" | "kind" | "source"> & {
      readonly id?: string;
      readonly kind?: "core";
      readonly source?: string;
    });

type DoctorHealthContribution = FlowContribution & {
  kind: "core";
  surface: "health";
  healthChecks: readonly HealthCheckInput[];
  healthCheckIds: readonly string[];
  run: (ctx: DoctorHealthFlowContext) => Promise<void>;
};

type DoctorHealthContributionTestApi = {
  createDoctorHealthContribution(params: {
    id: string;
    label: string;
    healthCheckIds?: readonly string[];
    healthChecks?: DoctorContributionHealthCheck | readonly DoctorContributionHealthCheck[];
    hint?: string;
    run?: (ctx: DoctorHealthFlowContext) => Promise<void>;
  }): DoctorHealthContribution;
  resolveDoctorHealthContributions(): DoctorHealthContribution[];
};

function getTestApi(): DoctorHealthContributionTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorHealthContributionsTestApi")
  ];
  if (!api) {
    throw new Error("doctor health contributions test API is unavailable");
  }
  return api as DoctorHealthContributionTestApi;
}

export function createDoctorHealthContribution(
  params: Parameters<DoctorHealthContributionTestApi["createDoctorHealthContribution"]>[0],
): DoctorHealthContribution {
  return getTestApi().createDoctorHealthContribution(params);
}

export function resolveDoctorHealthContributions(): DoctorHealthContribution[] {
  return getTestApi().resolveDoctorHealthContributions();
}
