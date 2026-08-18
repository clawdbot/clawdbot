import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { seedClawPackageBootstrap } from "./bootstrap.js";
import type { ClawCronGateway, installClawCronJobs, PersistedClawCronRef } from "./cron.js";
import type { installClawMcpServers, PersistedClawMcpServerRef } from "./mcp.js";
import type { installClawPackages } from "./packages.js";
import type {
  ClawInstallStatus,
  deleteClawInstallRecord,
  PersistedClawInstall,
  PersistedClawPackageRef,
  persistClawInstallRecord,
  updateClawInstallRecordStatus,
} from "./provenance.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "./types.js";
import type {
  createClawWorkspaceFiles,
  PersistedClawWorkspaceFile,
  ClawWorkspaceWriteError,
} from "./workspace.js";

export const CLAW_ADD_RESULT_SCHEMA_VERSION = "openclaw.clawAddResult.v1" as const;

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;

export type ClawAddApplyOptions = OpenClawStateDatabaseOptions & {
  consentPlanIntegrity?: string;
  resumeRecord?: PersistedClawInstall;
  resumePlan?: ClawAddPlan;
  commitConfig?: ConfigCommit;
  readConfig?: () => OpenClawConfig | Promise<OpenClawConfig>;
  persistRecord?: typeof persistClawInstallRecord;
  deleteRecord?: typeof deleteClawInstallRecord;
  updateRecord?: typeof updateClawInstallRecordStatus;
  createWorkspaceFiles?: typeof createClawWorkspaceFiles;
  runtime?: RuntimeEnv;
  installPackages?: typeof installClawPackages;
  installMcpServers?: typeof installClawMcpServers;
  installCronJobs?: typeof installClawCronJobs;
  seedPackageBootstrap?: typeof seedClawPackageBootstrap;
  cronGateway?: Pick<ClawCronGateway, "add" | "list" | "waitUntilAgentAvailable">;
  nowMs?: number;
};

export type ClawAddResult = {
  schemaVersion: typeof CLAW_ADD_RESULT_SCHEMA_VERSION;
  stability: "experimental";
  dryRun: false;
  mutationAllowed: true;
  planIntegrity: string;
  status: "complete" | "partial";
  claw: ClawAddPlan["claw"];
  agent: ClawAddPlan["agent"];
  workspaceCreated: boolean;
  configCommitted: boolean;
  workspaceFiles: PersistedClawWorkspaceFile[];
  packages: PersistedClawPackageRef[];
  mcpServers: PersistedClawMcpServerRef[];
  cronJobs: PersistedClawCronRef[];
  installRecord?: PersistedClawInstall;
  error?: {
    code: string;
    message: string;
    diagnostics?: ClawWorkspaceWriteError["diagnostics"];
  };
};

// Shapes every aborted apply into the same result, so callers read one contract whether the
// failure happened before the workspace, after the config commit, or anywhere between.
export function partialResult(params: {
  plan: ClawAddPlan;
  // Absent once an attempt has released its record: the result must not report ownership
  // that no longer exists in the state database.
  installRecord: PersistedClawInstall | undefined;
  workspaceCreated: boolean;
  configCommitted: boolean;
  workspaceFiles?: PersistedClawWorkspaceFile[];
  packages?: PersistedClawPackageRef[];
  installStatus?: ClawInstallStatus;
  mcpServers?: PersistedClawMcpServerRef[];
  cronJobs?: PersistedClawCronRef[];
  error: ClawAddResult["error"];
  nowMs?: number;
}): ClawAddResult {
  return {
    schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    mutationAllowed: true,
    planIntegrity: params.plan.planIntegrity,
    status: "partial",
    claw: params.plan.claw,
    agent: params.plan.agent,
    workspaceCreated: params.workspaceCreated,
    configCommitted: params.configCommitted,
    workspaceFiles: params.workspaceFiles ?? [],
    packages: params.packages ?? [],
    mcpServers: params.mcpServers ?? [],
    cronJobs: params.cronJobs ?? [],
    ...(params.installRecord
      ? {
          installRecord: {
            ...params.installRecord,
            status: params.installStatus ?? "partial",
            updatedAtMs: params.nowMs ?? Date.now(),
          },
        }
      : {}),
    error: params.error,
  };
}
