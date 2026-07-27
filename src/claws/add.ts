// Applies the package, agent, workspace, and managed-file slices of a consented Claw add plan.
import { lstat, mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { stableStringify } from "../agents/stable-stringify.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import {
  ClawCronInstallError,
  installClawCronJobs,
  type ClawCronGateway,
  type PersistedClawCronRef,
} from "./cron.js";
import {
  ClawMcpInstallError,
  installClawMcpServers,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
import { ClawPackageInstallError, installClawPackages } from "./packages.js";
import {
  deleteClawInstallRecord,
  persistClawInstallRecord,
  updateClawInstallRecordStatus,
  type ClawInstallStatus,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "./types.js";
import {
  ClawWorkspaceWriteError,
  createClawWorkspaceFiles,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

export const CLAW_ADD_RESULT_SCHEMA_VERSION = "openclaw.clawAddResult.v1" as const;

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;
type ClawAddApplyOptions = OpenClawStateDatabaseOptions & {
  consentPlanIntegrity?: string;
  commitConfig?: ConfigCommit;
  persistRecord?: typeof persistClawInstallRecord;
  deleteRecord?: typeof deleteClawInstallRecord;
  updateRecord?: typeof updateClawInstallRecordStatus;
  createWorkspaceFiles?: typeof createClawWorkspaceFiles;
  runtime?: RuntimeEnv;
  installPackages?: typeof installClawPackages;
  installMcpServers?: typeof installClawMcpServers;
  installCronJobs?: typeof installClawCronJobs;
  cronGateway?: Pick<ClawCronGateway, "add" | "list">;
  nowMs?: number;
};
export class ClawAddMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawAddMutationError";
  }
}

type ClawAddResult = {
  schemaVersion: typeof CLAW_ADD_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
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

function hasUnsupportedMutationActions(plan: ClawAddPlan): boolean {
  return plan.actions.some(
    (action) =>
      !["agent", "workspace", "workspaceFile", "package", "mcpServer", "cronJob"].includes(
        action.kind,
      ),
  );
}

function statusAtLeast(status: ClawInstallStatus, phase: ClawInstallStatus): boolean {
  const order: Record<ClawInstallStatus, number> = {
    pending: 0,
    partial: 0,
    workspace_ready: 1,
    config_committed: 2,
    complete: 3,
  };
  return order[status] >= order[phase];
}

function markInstallStatus(
  agentId: string,
  status: ClawInstallStatus,
  expectedStatuses: ClawInstallStatus[],
  options: ClawAddApplyOptions,
): void {
  (options.updateRecord ?? updateClawInstallRecordStatus)(agentId, status, {
    ...options,
    expectedStatuses,
  });
}

function clearUnownedInstallRecord(
  agentId: string,
  expectedStatuses: ClawInstallStatus[],
  options: ClawAddApplyOptions,
): void {
  (options.deleteRecord ?? deleteClawInstallRecord)(agentId, {
    ...options,
    expectedStatuses,
  });
}

function sameCommittedAgent(existingAgent: AgentConfig, plan: ClawAddPlan): boolean {
  return stableStringify(existingAgent) === stableStringify(plan.agent.config);
}

function workspacePathKey(value: string): string {
  return process.platform === "win32" ? normalizeWindowsPathForComparison(value) : value;
}

function assertWorkspacePathUnchanged(workspace: string): void {
  const canonicalWorkspace = resolvePathViaExistingAncestorSync(workspace);
  if (workspacePathKey(canonicalWorkspace) !== workspacePathKey(workspace)) {
    throw new ClawAddMutationError(
      "workspace_path_changed",
      `Workspace ancestry changed after planning: expected ${JSON.stringify(workspace)}, resolved ${JSON.stringify(canonicalWorkspace)}.`,
    );
  }
}

function partialResult(params: {
  plan: ClawAddPlan;
  installRecord: PersistedClawInstall;
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
    installRecord: {
      ...params.installRecord,
      status: params.installStatus ?? "partial",
      updatedAtMs: params.nowMs ?? Date.now(),
    },
    error: params.error,
  };
}

export async function applyClawAddPlan(
  plan: ClawAddPlan,
  options: ClawAddApplyOptions = {},
): Promise<ClawAddResult> {
  if (plan.blockers.length > 0) {
    throw new ClawAddMutationError("plan_blocked", "The Claw add plan contains blockers.");
  }
  if (hasUnsupportedMutationActions(plan)) {
    throw new ClawAddMutationError(
      "unsupported_components",
      "This build cannot add one or more declared Claw component kinds.",
    );
  }
  if (options.consentPlanIntegrity !== plan.planIntegrity) {
    throw new ClawAddMutationError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw add plan; run add --dry-run again.",
    );
  }

  const persistRecord = options.persistRecord ?? persistClawInstallRecord;
  let installRecord: PersistedClawInstall;
  try {
    installRecord = persistRecord(plan, { ...options, status: "pending" });
  } catch (error) {
    throw new ClawAddMutationError("provenance_failed", (error as Error).message);
  }

  const installPackages = options.installPackages ?? installClawPackages;
  let packages: PersistedClawPackageRef[] = [];

  const workspace = resolve(resolveUserPath(plan.agent.workspace));
  const workspacePhaseRecorded = statusAtLeast(installRecord.status, "workspace_ready");
  const workspaceState = workspacePhaseRecorded
    ? await lstat(workspace).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      })
    : undefined;
  if (workspaceState && !workspaceState.isDirectory()) {
    throw new ClawAddMutationError(
      "workspace_collision",
      `Workspace ${JSON.stringify(workspace)} is no longer a directory.`,
    );
  }
  let workspaceCreated = workspaceState?.isDirectory() ?? false;
  let configCommitted = statusAtLeast(installRecord.status, "config_committed");

  try {
    assertWorkspacePathUnchanged(workspace);
    await mkdir(dirname(workspace), { recursive: true });
    assertWorkspacePathUnchanged(workspace);
  } catch (error) {
    clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], options);
    if (error instanceof ClawAddMutationError) {
      throw error;
    }
    throw new ClawAddMutationError(
      "workspace_parent_failed",
      `Could not create parent directory for workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
    );
  }

  if (!workspaceCreated) {
    try {
      await mkdir(workspace);
      workspaceCreated = true;
    } catch (error) {
      markInstallStatus(plan.agent.finalId, "partial", ["pending", "partial"], options);
      return partialResult({
        plan,
        installRecord,
        workspaceCreated: false,
        configCommitted: false,
        packages,
        error: {
          code: "workspace_collision",
          message: `Could not create new workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
        },
        nowMs: options.nowMs,
      });
    }

    try {
      if (!workspacePhaseRecorded) {
        markInstallStatus(
          plan.agent.finalId,
          "workspace_ready",
          ["pending", "partial", "workspace_ready"],
          options,
        );
      }
    } catch (error) {
      const removedWorkspace = await rmdir(workspace)
        .then(() => true)
        .catch(() => false);
      if (removedWorkspace) {
        try {
          clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], options);
        } catch {
          // Preserve the phase-write failure if the unowned attempt cannot be reconciled.
        }
      }
      throw new ClawAddMutationError("provenance_failed", (error as Error).message);
    }
  }

  try {
    const commit: ConfigCommit =
      options.commitConfig ??
      (async (transform) => {
        await transformConfigFileWithRetry({
          afterWrite: { mode: "auto" },
          transform: (config) => ({ nextConfig: transform(config) }),
        });
      });
    await commit((config) => {
      const existingAgents = listAgentEntries(config);
      const agentsToPreserve: AgentConfig[] =
        existingAgents.length > 0 ? existingAgents : [{ id: DEFAULT_AGENT_ID, default: true }];
      const configWithPreservedAgents: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          entries: Object.fromEntries(agentsToPreserve.map(({ id, ...entry }) => [id, entry])),
        },
      };
      const normalizedAgentId = normalizeAgentId(plan.agent.finalId);
      const existingAgent = agentsToPreserve.find(
        (agent) => normalizeAgentId(agent.id) === normalizedAgentId,
      );
      if (existingAgent) {
        if (sameCommittedAgent(existingAgent, plan)) {
          configCommitted = true;
          return config;
        }
        throw new ClawAddMutationError(
          "agent_id_collision",
          "Agent " + JSON.stringify(plan.agent.finalId) + " was created after planning.",
        );
      }
      if (
        findOverlappingWorkspaceAgentIds(configWithPreservedAgents, plan.agent.finalId, workspace)
          .length > 0
      ) {
        throw new ClawAddMutationError(
          "workspace_collision",
          "Workspace " + JSON.stringify(workspace) + " is already assigned to an agent.",
        );
      }
      const nextConfig: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          entries: Object.fromEntries(
            [...agentsToPreserve, plan.agent.config].map(({ id, ...entry }) => [id, entry]),
          ),
        },
      };
      configCommitted = true;
      return nextConfig;
    });
    markInstallStatus(
      plan.agent.finalId,
      "config_committed",
      ["workspace_ready", "config_committed"],
      options,
    );
  } catch (error) {
    let installStatus: ClawInstallStatus = "workspace_ready";
    if (!configCommitted) {
      const removedWorkspace = await rmdir(workspace)
        .then(() => true)
        .catch(() => false);
      if (removedWorkspace) {
        workspaceCreated = false;
        installStatus = "partial";
        markInstallStatus(plan.agent.finalId, "partial", ["workspace_ready", "partial"], options);
      }
    }
    return partialResult({
      plan,
      installRecord,
      workspaceCreated,
      configCommitted,
      packages,
      installStatus,
      error: {
        code: error instanceof ClawAddMutationError ? error.code : "config_commit_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      nowMs: options.nowMs,
    });
  }

  const createFiles = options.createWorkspaceFiles ?? createClawWorkspaceFiles;
  let workspaceFiles: PersistedClawWorkspaceFile[] = [];
  try {
    workspaceFiles = await createFiles(plan, options);
  } catch (error) {
    const workspaceError =
      error instanceof ClawWorkspaceWriteError
        ? error
        : new ClawWorkspaceWriteError(
            [
              {
                level: "error",
                code: "workspace_file_io_error",
                phase: "mutation",
                path: "$.workspace",
                message: error instanceof Error ? error.message : String(error),
              },
            ],
            workspaceFiles,
          );
    markInstallStatus(plan.agent.finalId, "config_committed", ["config_committed"], options);
    return {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      mutationAllowed: true,
      planIntegrity: plan.planIntegrity,
      status: "partial",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated,
      configCommitted,
      workspaceFiles: workspaceError.createdFiles,
      packages,
      mcpServers: [],
      cronJobs: [],
      installRecord: {
        ...installRecord,
        status: "config_committed",
        updatedAtMs: options.nowMs ?? Date.now(),
      },
      error: {
        code: "workspace_files_failed",
        message: workspaceError.message,
        diagnostics: workspaceError.diagnostics,
      },
    };
  }

  let cronJobs: PersistedClawCronRef[] = [];
  try {
    // Skills require their workspace. Recurring work is enabled only after all
    // package mutation succeeds.
    packages = await installPackages(plan, options);
  } catch (error) {
    const packageError =
      error instanceof ClawPackageInstallError
        ? error
        : new ClawPackageInstallError(
            "package_install_failed",
            error instanceof Error ? error.message : String(error),
            packages,
          );
    return partialResult({
      plan,
      installRecord,
      workspaceCreated,
      configCommitted,
      workspaceFiles,
      packages: packageError.installedPackages,
      installStatus: "config_committed",
      error: { code: packageError.code, message: packageError.message },
      nowMs: options.nowMs,
    });
  }

  const installMcpServers = options.installMcpServers ?? installClawMcpServers;
  let mcpServers: PersistedClawMcpServerRef[] = [];
  try {
    mcpServers = await installMcpServers(plan, options);
  } catch (error) {
    const mcpError =
      error instanceof ClawMcpInstallError
        ? error
        : new ClawMcpInstallError(
            "mcp_install_failed",
            error instanceof Error ? error.message : String(error),
            mcpServers,
          );
    markInstallStatus(plan.agent.finalId, "config_committed", ["config_committed"], options);
    return partialResult({
      plan,
      installRecord,
      workspaceCreated,
      configCommitted,
      workspaceFiles,
      packages,
      mcpServers: mcpError.mcpServers,
      installStatus: "config_committed",
      error: { code: mcpError.code, message: mcpError.message },
      nowMs: options.nowMs,
    });
  }

  const installCronJobs = options.installCronJobs ?? installClawCronJobs;
  try {
    cronJobs = await installCronJobs(plan, { ...options, gateway: options.cronGateway });
  } catch (error) {
    const cronError =
      error instanceof ClawCronInstallError
        ? error
        : new ClawCronInstallError(
            "cron_install_failed",
            error instanceof Error ? error.message : String(error),
            cronJobs,
          );
    markInstallStatus(plan.agent.finalId, "config_committed", ["config_committed"], options);
    return partialResult({
      plan,
      installRecord,
      workspaceCreated,
      configCommitted,
      workspaceFiles,
      packages,
      mcpServers,
      cronJobs: cronError.cronJobs,
      installStatus: "config_committed",
      error: { code: cronError.code, message: cronError.message },
      nowMs: options.nowMs,
    });
  }

  try {
    markInstallStatus(plan.agent.finalId, "complete", ["config_committed", "complete"], options);
    return {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      mutationAllowed: true,
      planIntegrity: plan.planIntegrity,
      status: "complete",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated,
      configCommitted,
      packages,
      mcpServers,
      cronJobs,
      workspaceFiles,
      installRecord: {
        ...installRecord,
        status: "complete",
        updatedAtMs: options.nowMs ?? Date.now(),
      },
    };
  } catch (error) {
    return partialResult({
      plan,
      installRecord,
      workspaceCreated,
      configCommitted,
      workspaceFiles,
      packages,
      mcpServers,
      cronJobs,
      error: { code: "provenance_failed", message: (error as Error).message },
    });
  }
}
