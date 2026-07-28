import type { probeGatewayMemoryStatus } from "../commands/doctor-gateway-health.js";
import type { DoctorOptions, DoctorPrompter } from "../commands/doctor-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { buildGatewayConnectionDetails } from "../gateway/call.js";
import type { UpdatePostInstallDoctorResult } from "../infra/update-doctor-result.js";
import type { RuntimeEnv } from "../runtime.js";
import type { HealthCheckInput, RunnableHealthCheck } from "./health-check-runner-types.js";
import type { HealthCheck } from "./health-checks.js";
import type { FlowContribution } from "./types.js";

type DoctorConfigResult = {
  cfg: OpenClawConfig;
  path?: string;
  shouldWriteConfig?: boolean;
  sourceConfigValid?: boolean;
  sourceLastTouchedVersion?: string;
  skipPluginValidationOnWrite?: boolean;
  skipWizardMetadataForIncludeWrite?: boolean;
  preservedLegacyRootKeys?: readonly string[];
  shouldRepairCronCodexModelRefsAfterConfigWrite?: boolean;
  blockedCodexModelIdentities?: readonly string[];
};

export type DoctorHealthFlowContext = {
  runtime: RuntimeEnv;
  options: DoctorOptions;
  prompter: DoctorPrompter;
  configResult: DoctorConfigResult;
  cfg: OpenClawConfig;
  cfgForPersistence: OpenClawConfig;
  /** The finalized config-flow candidate crossed the atomic writer boundary. */
  configResultWriteCommitted?: boolean;
  /** One-shot repairs that require a durable config write have completed. */
  postConfigWriteRepairsCommitted?: boolean;
  sourceConfigValid: boolean;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  gatewayDetails?: ReturnType<typeof buildGatewayConnectionDetails>;
  healthOk?: boolean;
  gatewayHealthAuthenticated?: boolean;
  gatewayHealthSkipped?: boolean;
  gatewayStatus?: import("../commands/status.types.js").StatusSummary;
  gatewayMemoryProbe?: Awaited<ReturnType<typeof probeGatewayMemoryStatus>>;
  postInstallDoctorResult?: UpdatePostInstallDoctorResult;
};

export type DoctorHealthContribution = FlowContribution & {
  kind: "core";
  surface: "health";
  healthChecks: readonly HealthCheckInput[];
  healthCheckIds: readonly string[];
  run: (ctx: DoctorHealthFlowContext) => Promise<void>;
};

export type DoctorContributionHealthCheck =
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
