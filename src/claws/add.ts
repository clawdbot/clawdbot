// Applies the package, agent, workspace, and managed-file slices of a consented Claw add plan.
import type { Stats } from "node:fs";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import {
  hasUnsupportedMutationActions,
  planWithPackageActions,
  sameCommittedAgent,
  statusAtLeast,
} from "./add-plan-helpers.js";
import { ClawBootstrapWriteError, seedClawPackageBootstrap } from "./bootstrap.js";
import {
  ClawCronInstallError,
  installClawCronJobs,
  type ClawCronGateway,
  type PersistedClawCronRef,
} from "./cron.js";
import { replaceLegacyCommittedAgent } from "./legacy-resume.js";
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
import { planAdoptsWorkspace } from "./workspace-origin.js";
import {
  ClawWorkspaceWriteError,
  createClawWorkspaceFiles,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

export const CLAW_ADD_RESULT_SCHEMA_VERSION = "openclaw.clawAddResult.v1" as const;

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;
type ClawAddApplyOptions = OpenClawStateDatabaseOptions & {
  consentPlanIntegrity?: string;
  resumeRecord?: PersistedClawInstall;
  resumePlan?: ClawAddPlan;
  commitConfig?: ConfigCommit;
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
  if (options.consentPlanIntegrity !== (options.resumePlan?.planIntegrity ?? plan.planIntegrity)) {
    throw new ClawAddMutationError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw add plan; run add --dry-run again.",
    );
  }

  const persistRecord = options.persistRecord ?? persistClawInstallRecord;
  let installRecord: PersistedClawInstall;
  try {
    installRecord = persistRecord(plan, {
      ...options,
      status: "pending",
      expectedExistingRecord: options.resumeRecord,
      expectedExistingPlan: options.resumePlan,
      deferLegacyPlanUpgrade: options.resumePlan !== undefined,
    });
  } catch (error) {
    throw new ClawAddMutationError("provenance_failed", (error as Error).message);
  }

  const workspace = resolve(resolveUserPath(plan.agent.workspace));
  const workspacePhaseRecorded = statusAtLeast(installRecord.status, "workspace_ready");
  const workspaceAdoption = planAdoptsWorkspace(plan);
  let workspaceState: Stats | undefined;
  try {
    assertWorkspacePathUnchanged(workspace);
    workspaceState = await lstat(workspace).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
  } catch (error) {
    clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], options);
    if (error instanceof ClawAddMutationError) {
      throw error;
    }
    throw new ClawAddMutationError(
      "workspace_parent_failed",
      `Could not inspect workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
    );
  }

  if (!workspacePhaseRecorded && workspaceState && !workspaceAdoption) {
    markInstallStatus(plan.agent.finalId, "partial", ["pending", "partial"], options);
    return partialResult({
      plan,
      installRecord,
      workspaceCreated: false,
      configCommitted: false,
      packages: [],
      error: {
        code: "workspace_collision",
        message: `Workspace ${JSON.stringify(workspace)} was created after planning.`,
      },
      nowMs: options.nowMs,
    });
  }
  if (workspaceState && !workspaceState.isDirectory()) {
    throw new ClawAddMutationError(
      "workspace_collision",
      `Workspace ${JSON.stringify(workspace)} is no longer a directory.`,
    );
  }

  let workspaceCreated = workspaceState?.isDirectory() ?? false;
  let configCommitted = statusAtLeast(installRecord.status, "config_committed");
  if (workspaceAdoption && (!workspaceCreated || !workspacePhaseRecorded)) {
    const adoptedState = await lstat(workspace).catch(() => undefined);
    if (!adoptedState?.isDirectory()) {
      clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], options);
      throw new ClawAddMutationError(
        "workspace_collision",
        `Adoptable workspace ${JSON.stringify(workspace)} is no longer an existing directory.`,
      );
    }
    workspaceCreated = true;
    if (!workspacePhaseRecorded) {
      try {
        markInstallStatus(
          plan.agent.finalId,
          "workspace_ready",
          ["pending", "partial", "workspace_ready"],
          options,
        );
      } catch (error) {
        clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], options);
        throw new ClawAddMutationError("provenance_failed", (error as Error).message);
      }
    }
  }

  const installPackages = options.installPackages ?? installClawPackages;
  let packages: PersistedClawPackageRef[] = [];
  const preserveRecordedPhaseOrMarkPartial = (): ClawInstallStatus => {
    if (workspacePhaseRecorded) {
      return installRecord.status;
    }
    markInstallStatus(plan.agent.finalId, "partial", ["pending", "partial"], options);
    return "partial";
  };

  const hostRequirementPlan = planWithPackageActions(
    plan,
    (action) => action.details?.kind === "plugin",
  );
  const hostRequirementActions = hostRequirementPlan.actions.filter(
    (action) => action.kind === "package",
  );
  if (hostRequirementActions.length > 0) {
    try {
      packages = await installPackages(hostRequirementPlan, options);
    } catch (error) {
      const packageError =
        error instanceof ClawPackageInstallError
          ? error
          : new ClawPackageInstallError(
              "package_install_failed",
              coerceErrorMessage(error),
              packages,
            );
      const installStatus = preserveRecordedPhaseOrMarkPartial();
      return partialResult({
        plan,
        installRecord,
        workspaceCreated,
        configCommitted,
        packages: packageError.installedPackages,
        installStatus,
        error: { code: packageError.code, message: packageError.message },
        nowMs: options.nowMs,
      });
    }
  }

  try {
    assertWorkspacePathUnchanged(workspace);
    await mkdir(dirname(workspace), { recursive: true });
    assertWorkspacePathUnchanged(workspace);
  } catch (error) {
    if (packages.length > 0) {
      const installStatus = preserveRecordedPhaseOrMarkPartial();
      return partialResult({
        plan,
        installRecord,
        workspaceCreated,
        configCommitted,
        packages,
        installStatus,
        error: {
          code: error instanceof ClawAddMutationError ? error.code : "workspace_parent_failed",
          message:
            error instanceof ClawAddMutationError
              ? error.message
              : `Could not create parent directory for workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
        },
        nowMs: options.nowMs,
      });
    }
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

  // Seed and attest the consented package bootstrap while the workspace is still
  // private. Committing the agent config first makes the agent routable, so a
  // concurrent `sessions.create` can stock-seed BOOTSTRAP.md and strand the add at
  // `config_committed` with a seed conflict that no retry can clear.
  try {
    await (options.seedPackageBootstrap ?? seedClawPackageBootstrap)(plan, {
      ...options,
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    });
  } catch (error) {
    const installStatus: ClawInstallStatus = configCommitted
      ? "config_committed"
      : "workspace_ready";
    markInstallStatus(
      plan.agent.finalId,
      installStatus,
      configCommitted ? ["config_committed"] : ["workspace_ready", "config_committed"],
      options,
    );
    return partialResult({
      plan,
      installRecord,
      workspaceCreated,
      configCommitted,
      packages,
      installStatus,
      error: {
        code: error instanceof ClawBootstrapWriteError ? error.code : "bootstrap_write_failed",
        message: coerceErrorMessage(error),
      },
      nowMs: options.nowMs,
    });
  }

  // Workspace ownership must be complete before the agent becomes routable. Besides writing new
  // files, this reopens every adopted destination through the safe-file contract and records its
  // exact digest; a failure therefore leaves only retryable provenance, never an enabled agent.
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
    const installStatus: ClawInstallStatus = configCommitted
      ? "config_committed"
      : "workspace_ready";
    markInstallStatus(
      plan.agent.finalId,
      installStatus,
      configCommitted ? ["config_committed"] : ["workspace_ready"],
      options,
    );
    return partialResult({
      plan,
      installRecord,
      workspaceCreated,
      configCommitted,
      workspaceFiles: workspaceError.createdFiles,
      packages,
      installStatus,
      error: {
        code: "workspace_files_failed",
        message: workspaceError.message,
        diagnostics: workspaceError.diagnostics,
      },
      nowMs: options.nowMs,
    });
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
        const nextConfig = replaceLegacyCommittedAgent({
          config: configWithPreservedAgents,
          agents: agentsToPreserve,
          normalizedAgentId,
          plan,
          resumePlan: options.resumePlan,
          resumeRecord: options.resumeRecord,
          matchesPlan: sameCommittedAgent,
        });
        if (nextConfig) {
          configCommitted = true;
          return nextConfig;
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
    try {
      recordAgentProvenance(plan.agent.finalId, { createdVia: "claw" }, options);
    } catch (error) {
      throw new ClawAddMutationError("provenance_failed", coerceErrorMessage(error));
    }
    if (options.resumePlan && installRecord.schemaVersion === "openclaw.clawInstallRecord.v1") {
      installRecord = persistRecord(plan, {
        ...options,
        status: "pending",
        expectedExistingRecord: options.resumeRecord,
        expectedExistingPlan: options.resumePlan,
      });
    }
    markInstallStatus(
      plan.agent.finalId,
      "config_committed",
      ["workspace_ready", "config_committed"],
      options,
    );
  } catch (error) {
    let installStatus: ClawInstallStatus = "workspace_ready";
    if (!configCommitted && !workspaceAdoption) {
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
      workspaceFiles,
      packages,
      installStatus,
      error: {
        code: error instanceof ClawAddMutationError ? error.code : "config_commit_failed",
        message: coerceErrorMessage(error),
      },
      nowMs: options.nowMs,
    });
  }

  let cronJobs: PersistedClawCronRef[] = [];
  try {
    // Skills require their workspace. Recurring work is enabled only after all
    // package mutation succeeds.
    const workspacePackagePlan = planWithPackageActions(
      plan,
      (action) => action.details?.kind !== "plugin",
    );
    const workspacePackageActions = workspacePackagePlan.actions.filter(
      (action) => action.kind === "package",
    );
    if (workspacePackageActions.length > 0) {
      const workspacePackages = await installPackages(workspacePackagePlan, options);
      packages = [...packages, ...workspacePackages];
    }
  } catch (error) {
    const packageError =
      error instanceof ClawPackageInstallError
        ? error
        : new ClawPackageInstallError("package_install_failed", coerceErrorMessage(error), []);
    return partialResult({
      plan,
      installRecord,
      workspaceCreated,
      configCommitted,
      workspaceFiles,
      packages: [...packages, ...packageError.installedPackages],
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
        : new ClawMcpInstallError("mcp_install_failed", coerceErrorMessage(error), mcpServers);
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
        : new ClawCronInstallError("cron_install_failed", coerceErrorMessage(error), cronJobs);
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
