import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import { getRuntimeConfig } from "../config/config.js";
import { listConfiguredMcpServers, unsetConfiguredMcpServer } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabaseByPath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  clawCronGatewayJobMatchesRef,
  deleteClawCronRef,
  markClawCronRefRemoved,
  type ClawCronGateway,
} from "./cron.js";
import {
  claimClawAgentConfigRemoval,
  digestClawAgentRemovalSurface,
  type ConfigCommit,
} from "./lifecycle-config-removal.js";
import {
  clawRemoveQuietRuntime,
  ClawRemoveError,
  cleanupClawAgentFilesystem,
  deletionEffects,
  readAttachedCronJobs,
  releaseClawRemoveRows,
  removeClawWorkspaceFile,
  workspaceContainsUntrackedEntries,
  type ClawTrashPath,
  type RemovedWorkspaceFile,
} from "./lifecycle-delete-support.js";
import { removeClawMcpServers } from "./lifecycle-mcp-removal.js";
import {
  CLAW_REMOVE_PLAN_SCHEMA_VERSION,
  type ClawRemovePlan,
  type ClawRemovePlanAction,
  type RemovedCronJob,
  type RemovedMcpServer,
} from "./lifecycle-remove-contract.js";
import { readClawStatus } from "./lifecycle-status.js";
import { clawMcpRemovalSelector, planClawMcpServerRemoval } from "./mcp.js";
import { projectClawPackageRemovePlan } from "./package-remove-plan.js";
import {
  applyClawPackageRemovals,
  planClawPackageRemovals,
  type ClawPackageRemovalResult,
  type ClawReferencedCleanup,
  type PackageRemovalDeps,
} from "./package-remove.js";
import { updateClawInstallRecordStatus } from "./provenance.js";
import { CLAW_OUTPUT_STABILITY } from "./types.js";

export { ClawRemoveError } from "./lifecycle-delete-support.js";
export { CLAW_REMOVE_PLAN_SCHEMA_VERSION } from "./lifecycle-remove-contract.js";
export { readClawStatus } from "./lifecycle-status.js";

export const CLAW_REMOVE_RESULT_SCHEMA_VERSION = "openclaw.clawRemoveResult.v1" as const;
type ClawRemoveResult = {
  schemaVersion: typeof CLAW_REMOVE_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  status: "complete" | "partial";
  agentId: string;
  agentRemoved: boolean;
  workspaceFiles: RemovedWorkspaceFile[];
  packages: ClawPackageRemovalResult[];
  mcpServers: RemovedMcpServer[];
  cronJobs: RemovedCronJob[];
  packageRefsReleased: number;
  error?: { code: string; message: string };
};

export async function buildClawRemovePlan(
  target: string,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    sourceMcpServers?: Record<string, Record<string, unknown>>;
    listMcpServers?: typeof listConfiguredMcpServers;
    packageDeps?: PackageRemovalDeps;
    referencedCleanup?: ClawReferencedCleanup;
  } = {},
): Promise<ClawRemovePlan> {
  const status = await readClawStatus(target, options);
  const blockers: ClawRemovePlan["blockers"] = [];
  if (status.records.length === 0) {
    blockers.push({
      code: "claw_not_found",
      message: `No installed Claw matches ${JSON.stringify(target)}.`,
    });
  } else if (status.records.length > 1) {
    blockers.push({
      code: "claw_ambiguous",
      message: `Claw name ${JSON.stringify(target)} matches multiple agents; use an agent id.`,
    });
  }
  const record = status.records.length === 1 ? status.records[0] : undefined;
  if (record?.agentState === "modified") {
    blockers.push({
      code: "agent_modified",
      message: `Agent ${JSON.stringify(record.install.agentId)} changed after add.`,
    });
  }
  for (const file of record?.workspaceFiles ?? []) {
    if (file.state === "unsafe") {
      blockers.push({
        code: "workspace_file_unsafe",
        message: `${file.path}: ${file.message ?? "unsafe file"}`,
      });
    }
  }
  for (const server of record?.mcpServers ?? []) {
    if (server.state === "pending") {
      blockers.push({
        code: "mcp_cleanup_uncertain",
        message: `MCP server ${JSON.stringify(server.name)} has ${server.state} ownership state and must be reconciled before removal.`,
      });
    }
  }
  for (const cron of record?.cronJobs ?? []) {
    if (cron.status !== "removed" && (cron.status !== "complete" || !cron.schedulerJobId)) {
      blockers.push({
        code: "cron_cleanup_uncertain",
        message: `Cron declaration ${JSON.stringify(cron.manifestId)} has ${cron.status} ownership state and must be reconciled before removal.`,
      });
    }
  }
  const actions: ClawRemovePlanAction[] = [];
  if (record) {
    const selectedResources = options.referencedCleanup?.selected ?? [];
    const packageCleanup = options.referencedCleanup
      ? {
          ...options.referencedCleanup,
          selected: selectedResources.filter((selector) => !selector.startsWith("mcp:")),
        }
      : undefined;
    const mcpCleanup = options.referencedCleanup
      ? {
          ...options.referencedCleanup,
          selected: selectedResources.filter((selector) => selector.startsWith("mcp:")),
        }
      : undefined;
    const packageDecisions = await planClawPackageRemovals(record.install, record.packages, {
      ...options,
      deps: options.packageDeps,
      referencedCleanup: packageCleanup,
    });
    const packagePlan = projectClawPackageRemovePlan({
      decisions: packageDecisions,
      inspections: record.packages,
      cleanup: packageCleanup,
    });
    blockers.push(...packagePlan.blockers);
    const effects = deletionEffects(
      options.config ?? getRuntimeConfig(),
      record.install.agentId,
      record.install.workspace,
    );
    const workspaceHasModifiedFiles = record.workspaceFiles.some(
      (file) => file.state === "modified",
    );
    const workspaceHasUntrackedEntries = await workspaceContainsUntrackedEntries(
      record.install.workspace,
      record.workspaceFiles.map((file) => file.path),
    );
    const attachedJobs = readAttachedCronJobs(record.install.agentId, options);
    const ownedSchedulerJobIds = new Set(
      record.cronJobs
        .filter((cron) => cron.status !== "removed" && cron.schedulerJobId)
        .map((cron) => cron.schedulerJobId),
    );
    for (const job of attachedJobs.filter((candidate) => !ownedSchedulerJobIds.has(candidate.id))) {
      blockers.push({
        code: "agent_job_attached",
        message: `Cron job ${JSON.stringify(job.id)} still references agent ${JSON.stringify(record.install.agentId)}; reassign or remove it first.`,
      });
    }
    actions.push({
      kind: "agent",
      id: record.install.agentId,
      action: "remove",
      target: `agents.entries[${JSON.stringify(record.install.agentId)}]`,
      blocked: record.agentState === "modified",
      details: {
        expectedState: record.agentState,
        configDigest: record.install.agentConfigDigest,
        removalSurfaceDigest: digestClawAgentRemovalSurface(
          options.config ?? getRuntimeConfig(),
          record.install.agentId,
        ),
        ownedPaths: record.install.agentOwnedPaths,
      },
      ...(record.agentState === "modified" ? { reason: "Agent config digest changed." } : {}),
    });
    if (effects.pruned.removedBindings > 0) {
      actions.push({
        kind: "configBinding",
        id: record.install.agentId,
        action: "remove",
        target: `bindings[agentId=${record.install.agentId}]`,
        blocked: record.agentState === "modified",
        details: { count: effects.pruned.removedBindings },
      });
    }
    if (effects.pruned.removedAllow > 0) {
      actions.push({
        kind: "agentAllow",
        id: record.install.agentId,
        action: "remove",
        target: `tools.agentToAgent.allow[${record.install.agentId}]`,
        blocked: record.agentState === "modified",
        details: { count: effects.pruned.removedAllow },
      });
    }
    if (effects.workspace) {
      actions.push({
        kind: "workspace",
        id: record.install.agentId,
        action:
          effects.workspaceRetained || workspaceHasModifiedFiles || workspaceHasUntrackedEntries
            ? "retain"
            : "trash",
        target: effects.workspace,
        blocked: record.agentState === "modified",
        details: {
          retained:
            effects.workspaceRetained || workspaceHasModifiedFiles || workspaceHasUntrackedEntries,
          sharedWith: effects.workspaceSharedWith,
        },
        ...(effects.workspaceRetained
          ? { reason: "Workspace overlaps another agent." }
          : workspaceHasModifiedFiles
            ? { reason: "Workspace contains locally modified Claw-managed files." }
            : workspaceHasUntrackedEntries
              ? { reason: "Workspace contains files or directories not managed by this Claw." }
              : {}),
      });
    }
    if (effects.agentDir) {
      actions.push({
        kind: "agentState",
        id: record.install.agentId,
        action: "trash",
        target: effects.agentDir,
        blocked: record.agentState === "modified",
      });
    }
    actions.push({
      kind: "sessionIndex",
      id: record.install.agentId,
      action: "delete",
      target: `session store entries for agent:${record.install.agentId}`,
      blocked: record.agentState === "modified",
    });
    actions.push({
      kind: "sessionTranscripts",
      id: record.install.agentId,
      action: "trash",
      target: effects.sessionsDir,
      blocked: record.agentState === "modified",
    });
    for (const job of attachedJobs) {
      actions.push({
        kind: "scheduledJob",
        id: job.id,
        action: "retain",
        target: `cron_jobs:${job.id}`,
        blocked: true,
        reason: "Operator-owned scheduled work must be reassigned or removed explicitly.",
        details: {
          name: job.name,
          enabled: job.enabled,
          agentId: job.agentId,
          ownerAgentId: job.ownerAgentId,
        },
      });
    }
    for (const file of record.workspaceFiles) {
      actions.push({
        kind: "workspaceFile",
        id: file.path,
        action: file.state === "unchanged" ? "delete" : "retain",
        target: `${file.workspace}:${file.path}`,
        blocked: file.state === "unsafe",
        details: {
          expectedState: file.state,
          contentDigest: file.contentDigest,
          workspace: file.workspace,
        },
        ...(file.state === "modified"
          ? { reason: "Local content changed; preserve the file." }
          : {}),
      });
    }
    actions.push(...packagePlan.actions);
    const unmatchedMcpSelectors = new Set(mcpCleanup?.selected ?? []);
    for (const server of record.mcpServers) {
      const blocked = server.state === "pending";
      const decision = planClawMcpServerRemoval(server, {
        ...options,
        referencedCleanup: mcpCleanup,
      });
      unmatchedMcpSelectors.delete(clawMcpRemovalSelector(server));
      if (decision.blocked) {
        blockers.push({
          code: "referenced_cleanup_requires_override",
          message: `${clawMcpRemovalSelector(server)}: ${decision.reason ?? "explicit conflict override is required"}`,
        });
      }
      actions.push({
        kind: "mcpServer",
        id: server.name,
        action: blocked ? "retain" : decision.action,
        target: `mcp.servers.${server.name}`,
        blocked,
        details: {
          expectedState: server.state,
          configDigest: server.configDigest,
          relationship: server.relationship,
          origin: server.origin,
          independentOwner: server.independentOwner,
          affectedClawAgentIds: decision.affectedClawAgentIds,
          cleanupMode: mcpCleanup?.mode ?? "retain",
          availableCleanupModes:
            server.relationship === "referenced"
              ? ["retain", "remove-if-unused", "remove-selected"]
              : ["remove"],
        },
        ...(blocked
          ? { reason: `MCP ownership state is ${server.state}.` }
          : decision.reason
            ? { reason: decision.reason }
            : {}),
      });
    }
    for (const selector of unmatchedMcpSelectors) {
      blockers.push({
        code: "referenced_cleanup_not_found",
        message: `Selected referenced resource ${JSON.stringify(selector)} is not owned by this Claw.`,
      });
    }
    for (const cron of record.cronJobs) {
      const blocked =
        cron.status !== "removed" && (cron.status !== "complete" || !cron.schedulerJobId);
      actions.push({
        kind: "cronJob",
        id: cron.manifestId,
        action: blocked ? "retain" : "remove",
        target: cron.schedulerJobId ?? cron.declarationKey,
        blocked,
        details: {
          expectedStatus: cron.status,
          declarationKey: cron.declarationKey,
          schedulerJobId: cron.schedulerJobId,
          job: cron.job,
        },
        ...(blocked ? { reason: `Cron ownership state is ${cron.status}.` } : {}),
      });
    }
    actions.push({
      kind: "installRecord",
      id: record.install.agentId,
      action: "remove",
      target: `claw_installs:${record.install.agentId}`,
      blocked: false,
      details: {
        expectedStatus: record.install.status,
        planIntegrity: record.install.planIntegrity,
        sourceIntegrity: record.install.claw.integrity,
      },
    });
  }
  const planIdentity = {
    target,
    agentId: record?.install.agentId,
    actions,
    blockers,
  };
  return {
    schemaVersion: CLAW_REMOVE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: `sha256:${createHash("sha256")
      .update(stableStringify(planIdentity))
      .digest("hex")}`,
    target,
    ...(record ? { agentId: record.install.agentId } : {}),
    actions,
    blockers,
  };
}

type PurgeSessions = (config: OpenClawConfig, agentId: string) => Promise<void>;
export async function applyClawRemovePlan(
  plan: ClawRemovePlan,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    sourceMcpServers?: Record<string, Record<string, unknown>>;
    listMcpServers?: typeof listConfiguredMcpServers;
    commitConfig?: ConfigCommit;
    packageDeps?: PackageRemovalDeps;
    referencedCleanup?: ClawReferencedCleanup;
    purgeSessions?: PurgeSessions;
    trashPath?: ClawTrashPath;
    consentPlanIntegrity?: string;
    unsetMcpServer?: typeof unsetConfiguredMcpServer;
    cronGateway?: Pick<ClawCronGateway, "get" | "remove">;
  } = {},
): Promise<ClawRemoveResult> {
  if (options.consentPlanIntegrity !== plan.planIntegrity) {
    throw new ClawRemoveError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw remove plan; run remove --dry-run again.",
    );
  }
  if (plan.blockers.length > 0 || !plan.agentId) {
    throw new ClawRemoveError("remove_blocked", "The Claw remove plan contains blockers.");
  }
  const currentPlan = await buildClawRemovePlan(plan.target, options);
  if (currentPlan.planIntegrity !== plan.planIntegrity) {
    throw new ClawRemoveError("remove_changed", "Claw-owned state changed after remove planning.");
  }
  const agentId = plan.agentId;
  const plannedAgentAction = plan.actions.find(
    (action) => action.kind === "agent" && action.id === agentId,
  );
  const expectedRemovalSurfaceDigest = plannedAgentAction?.details?.removalSurfaceDigest;
  if (typeof expectedRemovalSurfaceDigest !== "string") {
    throw new ClawRemoveError("remove_changed", "Claw remove plan is missing config state.");
  }
  const current = await readClawStatus(plan.agentId, options);
  const record = current.records[0];
  if (
    !record ||
    record.agentState === "modified" ||
    record.workspaceFiles.some((file) => file.state === "unsafe") ||
    record.mcpServers.some((server) => server.state === "pending")
  ) {
    throw new ClawRemoveError("remove_changed", "Claw-owned state changed after remove planning.");
  }
  const packageDecisions = await planClawPackageRemovals(record.install, record.packages, {
    ...options,
    deps: options.packageDeps,
    referencedCleanup: options.referencedCleanup
      ? {
          ...options.referencedCleanup,
          selected: (options.referencedCleanup.selected ?? []).filter(
            (selector) => !selector.startsWith("mcp:"),
          ),
        }
      : undefined,
  });
  const plannedPackages = plan.actions
    .filter((action) => action.kind === "packageRef")
    .map((action) => `${action.id}:${action.action}`)
    .toSorted();
  const currentPackages = packageDecisions
    .map(
      (decision) =>
        `${decision.packageRef.kind}:${decision.packageRef.ref}@${decision.packageRef.version}:${decision.action === "uninstall" ? "uninstall" : "release"}`,
    )
    .toSorted();
  if (JSON.stringify(plannedPackages) !== JSON.stringify(currentPackages)) {
    throw new ClawRemoveError("remove_changed", "Package ownership changed after remove planning.");
  }
  const plannedMcpServers = plan.actions
    .filter((action) => action.kind === "mcpServer")
    .map((action) => `${action.id}:${action.action}`)
    .toSorted();
  const currentMcpServers = record.mcpServers
    .map((server) => `${server.name}:${planClawMcpServerRemoval(server, options).action}`)
    .toSorted();
  if (JSON.stringify(plannedMcpServers) !== JSON.stringify(currentMcpServers)) {
    throw new ClawRemoveError("remove_changed", "MCP ownership changed after remove planning.");
  }
  const mcpRemoval = await removeClawMcpServers({
    agentId: plan.agentId,
    servers: record.mcpServers,
    options,
  });
  const mcpServers = mcpRemoval.mcpServers;
  if (mcpRemoval.error) {
    updateClawInstallRecordStatus(agentId, "partial", options);
    return {
      schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      status: "partial",
      agentId,
      agentRemoved: false,
      workspaceFiles: [],
      packages: [],
      mcpServers,
      cronJobs: [],
      packageRefsReleased: 0,
      error: { code: "mcp_cleanup_failed", message: mcpRemoval.error },
    };
  }
  const cronJobs: RemovedCronJob[] = [];
  for (const cron of record.cronJobs) {
    if (cron.status !== "removed" && (!cron.schedulerJobId || cron.status !== "complete")) {
      throw new ClawRemoveError(
        "cron_cleanup_uncertain",
        `Cron declaration ${JSON.stringify(cron.manifestId)} is not safely removable.`,
      );
    }
    if (cron.status !== "removed" && (!options.cronGateway?.get || !options.cronGateway.remove)) {
      throw new ClawRemoveError(
        "cron_gateway_required",
        "Claw cron jobs require the gateway-owned cron.get and cron.remove APIs.",
      );
    }
    try {
      if (cron.status !== "removed") {
        const live = await options.cronGateway!.get!(cron.schedulerJobId!);
        if (live != null && !clawCronGatewayJobMatchesRef(plan.agentId, cron, live)) {
          throw new Error(
            `Cron declaration ${JSON.stringify(cron.manifestId)} changed after planning.`,
          );
        }
        if (live != null) {
          try {
            await options.cronGateway!.remove(cron.schedulerJobId!);
          } catch (removeError) {
            // A transport failure can lose a successful cron.remove response. Re-read the
            // gateway before preserving ownership so retries can converge on confirmed absence.
            const afterRemove = await options.cronGateway!.get!(cron.schedulerJobId!);
            if (afterRemove != null) {
              throw removeError;
            }
          }
        }
        markClawCronRefRemoved(plan.agentId, cron.manifestId, options);
      }
      deleteClawCronRef(plan.agentId, cron.manifestId, options);
      cronJobs.push({
        manifestId: cron.manifestId,
        schedulerJobId: cron.schedulerJobId,
        action: "removed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cronJobs.push({
        manifestId: cron.manifestId,
        schedulerJobId: cron.schedulerJobId,
        action: "error",
        message,
      });
      updateClawInstallRecordStatus(agentId, "partial", options);
      return {
        schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: false,
        status: "partial",
        agentId: plan.agentId,
        agentRemoved: false,
        workspaceFiles: [],
        packages: [],
        mcpServers,
        cronJobs,
        packageRefsReleased: 0,
        error: { code: "cron_cleanup_failed", message },
      };
    }
  }
  const configRemoval = await claimClawAgentConfigRemoval({
    agentId,
    expectedDigest: record.install.agentConfigDigest,
    expectedRemovalSurfaceDigest,
    expectedState: record.agentState,
    fallbackWorkspace: record.install.workspace,
    config: options.config,
    commitConfig: options.commitConfig,
    trashPath: options.trashPath,
    onModified: () => new ClawRemoveError("agent_modified", "Agent config changed during remove."),
  });
  const {
    agentRemoved,
    cleanupTargets,
    configBeforeDelete,
    nextConfig: committedNextConfig,
  } = configRemoval;
  if (!options.commitConfig || options.purgeSessions) {
    const purgeSessions =
      options.purgeSessions ??
      (await import("../config/sessions/cleanup-service.js")).purgeAgentSessionStoreEntries;
    await purgeSessions(configBeforeDelete, agentId);
  }
  closeOpenClawAgentDatabaseByPath(resolveOpenClawAgentSqlitePath({ agentId, env: options.env }));
  const packages = await applyClawPackageRemovals(
    packageDecisions.toSorted(
      (left, right) =>
        Number(left.packageRef.relationship === "referenced") -
        Number(right.packageRef.relationship === "referenced"),
    ),
    {
      ...options,
      deps: options.packageDeps,
    },
  );
  const packageErrors = packages.filter((pkg) => pkg.action === "error");
  if (packageErrors.length > 0) {
    updateClawInstallRecordStatus(agentId, "partial", options);
    return {
      schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      status: "partial",
      agentId: plan.agentId,
      agentRemoved,
      workspaceFiles: [],
      packages,
      mcpServers,
      cronJobs,
      packageRefsReleased: 0,
      error: {
        code: "package_cleanup_failed",
        message: packageErrors.map((pkg) => pkg.reason).join("; "),
      },
    };
  }
  const workspaceFiles: RemovedWorkspaceFile[] = [];
  for (const file of record.workspaceFiles) {
    workspaceFiles.push(await removeClawWorkspaceFile(file));
  }
  const cleanupErrors = workspaceFiles
    .filter((file) => file.action === "error")
    .map((file) => file.message ?? `Could not remove ${file.path}.`);
  if (cleanupErrors.length === 0 && cleanupTargets && committedNextConfig) {
    const workspaceHasRemainingEntries = await workspaceContainsUntrackedEntries(
      cleanupTargets.workspaceDir,
      record.workspaceFiles.map((file) => file.path),
    );
    cleanupErrors.push(
      ...(await cleanupClawAgentFilesystem({
        agentId,
        nextConfig: committedNextConfig,
        targets: cleanupTargets,
        runtime: clawRemoveQuietRuntime,
        trashPath: options.trashPath,
        retainWorkspace:
          workspaceHasRemainingEntries ||
          workspaceFiles.some((file) => file.action === "retainedModified"),
      })),
    );
  }
  const complete = cleanupErrors.length === 0;
  if (!complete) {
    updateClawInstallRecordStatus(agentId, "partial", options);
  }
  releaseClawRemoveRows(plan.agentId, workspaceFiles, complete, options);
  return {
    schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    status: complete ? "complete" : "partial",
    agentId: plan.agentId,
    agentRemoved,
    workspaceFiles,
    packages,
    mcpServers,
    cronJobs,
    packageRefsReleased: complete ? record.packages.length : 0,
    ...(complete
      ? {}
      : {
          error: {
            code: "workspace_cleanup_failed",
            message: cleanupErrors.join("; "),
          },
        }),
  };
}
