import type { unsetConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import type { listConfiguredMcpServers } from "../config/mcp-config.js";
import type { purgeAgentSessionStoreEntries } from "../config/sessions/cleanup-service.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { ClawCronGateway } from "./cron.js";
import type { ConfigCommit } from "./lifecycle-config-removal.js";
import type { ClawTrashPath, RemovedWorkspaceFile } from "./lifecycle-delete-support.js";
import type { ClawMonitorCleanupGateway } from "./monitor-cleanup-contract.js";
import type {
  ClawPackageRemovalResult,
  ClawReferencedCleanup,
  PackageRemovalDeps,
} from "./package-remove.js";
import { CLAW_OUTPUT_STABILITY } from "./types.js";

export const CLAW_REMOVE_PLAN_SCHEMA_VERSION = "openclaw.clawRemovePlan.v1" as const;

export type ClawRemovePlanAction = {
  kind:
    | "agent"
    | "configBinding"
    | "agentAllow"
    | "workspace"
    | "agentState"
    | "sessionIndex"
    | "sessionTranscripts"
    | "scheduledJob"
    | "workspaceFile"
    | "bootstrap"
    | "packageRef"
    | "mcpServer"
    | "cronJob"
    | "installRecord";
  id: string;
  action: "remove" | "delete" | "retain" | "release" | "uninstall" | "trash";
  target: string;
  blocked: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

export type ClawRemovePlan = {
  schemaVersion: typeof CLAW_REMOVE_PLAN_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  planIntegrity: string;
  target: string;
  agentId?: string;
  actions: ClawRemovePlanAction[];
  blockers: Array<{ code: string; message: string }>;
};

type RemovedCronJob = {
  manifestId: string;
  schedulerJobId?: string;
  action: "removed" | "error";
  message?: string;
};

export type RemovedMcpServer = {
  name: string;
  action: "removed" | "missing" | "released" | "error";
  message?: string;
};

export type ClawRemovePlanOptions = OpenClawStateDatabaseOptions & {
  config?: OpenClawConfig;
  sourceMcpServers?: Record<string, Record<string, unknown>>;
  listMcpServers?: typeof listConfiguredMcpServers;
  packageDeps?: PackageRemovalDeps;
  referencedCleanup?: ClawReferencedCleanup;
  monitorGateway?: ClawMonitorCleanupGateway;
};

export type ClawRemoveApplyOptions = ClawRemovePlanOptions & {
  commitConfig?: ConfigCommit;
  purgeSessions?: (
    ...args: Parameters<typeof purgeAgentSessionStoreEntries>
  ) => Promise<boolean | void>;
  trashPath?: ClawTrashPath;
  consentPlanIntegrity?: string;
  unsetMcpServer?: typeof unsetConfiguredMcpServer;
  cronGateway?: Pick<ClawCronGateway, "get" | "remove">;
};

export const CLAW_REMOVE_RESULT_SCHEMA_VERSION = "openclaw.clawRemoveResult.v1" as const;
export type ClawRemoveResult = {
  schemaVersion: typeof CLAW_REMOVE_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  status: "complete" | "partial";
  agentId: string;
  agentRemoved: boolean;
  bootstrap?: RemovedWorkspaceFile;
  workspaceFiles: RemovedWorkspaceFile[];
  packages: ClawPackageRemovalResult[];
  mcpServers: RemovedMcpServer[];
  cronJobs: RemovedCronJob[];
  packageRefsReleased: number;
  error?: { code: string; message: string };
};
