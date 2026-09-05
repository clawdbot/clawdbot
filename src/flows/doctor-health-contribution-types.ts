import type { RetiredAuthProfileCleanupPlan } from "../commands/doctor-auth-legacy-oauth.js";
import type { probeGatewayMemoryStatus } from "../commands/doctor-gateway-health.js";
import type { DoctorOptions, DoctorPrompter } from "../commands/doctor-prompter.js";
import type { ShippedPluginInstallConfigImport } from "../commands/doctor/shared/plugin-registry-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { buildGatewayConnectionDetails } from "../gateway/call.js";
import type { UpdatePostInstallDoctorResult } from "../infra/update-doctor-result.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import type { RuntimeEnv } from "../runtime.js";
import type { HealthCheckInput, RunnableHealthCheck } from "./health-check-runner-types.js";
import type { HealthCheck, HealthCheckContext } from "./health-checks.js";
import type { FlowContribution } from "./types.js";

type DoctorConfigResult = {
  cfg: OpenClawConfig;
  pluginInstallConfigImport?: ShippedPluginInstallConfigImport;
  path?: string;
  shouldWriteConfig?: boolean;
  /** Repair panels held back until the atomic config write commits. */
  pendingChangePanels?: readonly string[];
  sourceConfigValid?: boolean;
  sourceLastTouchedVersion?: string;
  skipPluginValidationOnWrite?: boolean;
  explicitSetPaths?: readonly (readonly string[])[];
  persistCanonicalAgentRoster?: boolean;
  skipWizardMetadataForIncludeWrite?: boolean;
  preservedLegacyRootKeys?: readonly string[];
  shouldRepairCronCodexModelRefsAfterConfigWrite?: boolean;
  retiredPhoneControlStateCleanupPending?: boolean;
  /** Store cleanup deferred until the repaired config reaches disk. */
  retiredAuthProfileCleanupPlans?: readonly RetiredAuthProfileCleanupPlan[];
  blockedCodexModelIdentities?: readonly string[];
  /** Ephemeral doctor-only auth rename plan; never part of persisted config. */
  openAICodexAuthProfileIdMap?: ReadonlyMap<string, string>;
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
  invalidatePluginMetadataSnapshot?: () => void;
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
  /** The requested config write was refused; later repairs must not consume its candidate. */
  configWriteRefusal?: "validation" | "cron-owner-safety";
  /** One-shot repairs that require a durable config write have completed. */
  postConfigWriteRepairsCommitted?: boolean;
  sourceConfigValid: boolean;
  configPath: string;
  /** Whether the selected state directory already existed before doctor startup work. */
  stateDirExistedAtStart?: boolean;
  env?: NodeJS.ProcessEnv;
  /** State migration owns service activation until final readiness passes. */
  gatewayMaintenanceActive?: boolean;
  gatewayDetails?: ReturnType<typeof buildGatewayConnectionDetails>;
  healthOk?: boolean;
  gatewayHealthAuthenticated?: boolean;
  gatewayHealthSkipped?: boolean;
  gatewayStatus?: import("../status/types.js").StatusSummary;
  gatewayMemoryProbe?: Awaited<ReturnType<typeof probeGatewayMemoryStatus>>;
  postInstallDoctorResult?: UpdatePostInstallDoctorResult;
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
  invalidatePluginMetadataSnapshot?: () => void;
};

/** Internal facts carried through Doctor detect/repair/validate passes without widening the SDK. */
export type DoctorHealthCheckContext = HealthCheckContext & {
  readonly runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
};

export type DoctorHealthContribution = FlowContribution & {
  kind: "core";
  surface: "health";
  required?: true;
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
  | (Omit<RunnableHealthCheck, "id" | "kind" | "source" | "sourceContract"> & {
      readonly id?: string;
      readonly kind?: "core";
      readonly source?: string;
    });
