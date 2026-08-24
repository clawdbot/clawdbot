import { createHash } from "node:crypto";
import { coerceErrorMessage, stableStringify } from "@openclaw/normalization-core";
import { listAgentEntries } from "../agents/agent-scope.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { clawTargetPackages } from "./application-provenance.js";
import { applyClawCronUpdate, ClawCronUpdateError } from "./cron-update.js";
import type { ClawCronGateway } from "./cron.js";
import { buildClawAddPlan, type ClawAddPlanContext } from "./lifecycle.js";
import { applyClawMcpUpdate, ClawMcpUpdateError } from "./mcp-update.js";
import { ClawUpdateMutationError, runOwnedUpdateSteps } from "./owned-update-steps.js";
import { coercePluginVersionConflictForUpdate } from "./package-preflight-coercion.js";
import {
  applyClawPackageUpdate,
  ClawPackageUpdateError,
  type ClawPackageUpdateExecution,
} from "./package-update.js";
import {
  readClawInstallRecord,
  updateClawInstallRecord,
  updateClawInstallRecordStatus,
  type PersistedClawInstall,
} from "./provenance.js";
import {
  CLAW_OUTPUT_STABILITY,
  type ClawManifest,
  type ClawOpenClawProfile,
  type ClawSourceIdentity,
} from "./types.js";
import { buildClawUpdatePlan, type ClawUpdateAction, type ClawUpdatePlan } from "./update-plan.js";
import { applyClawWorkspaceUpdate, ClawWorkspaceUpdateError } from "./workspace-update.js";

export const CLAW_UPDATE_RESULT_SCHEMA_VERSION = "openclaw.clawUpdateResult.v1" as const;

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export { ClawUpdateMutationError } from "./owned-update-steps.js";

type ClawUpdateResult = {
  schemaVersion: typeof CLAW_UPDATE_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  mutationAllowed: true;
  status: "complete";
  agentId: string;
  previousClaw: NonNullable<ClawUpdatePlan["currentClaw"]>;
  targetClaw: NonNullable<ClawUpdatePlan["targetClaw"]>;
  appliedActions: ClawUpdateAction[];
  skippedActions?: ClawUpdateAction[];
  installRecord: PersistedClawInstall;
};

function comparablePlan(plan: ClawUpdatePlan): unknown {
  return {
    found: plan.found,
    agentId: plan.agentId,
    currentClaw: plan.currentClaw,
    targetClaw: plan.targetClaw,
    actions: plan.actions,
    capabilityChanges: plan.capabilityChanges,
    readiness: plan.readiness,
    blockers: plan.blockers,
  };
}

function unchangedPackagePaths(plan: ClawUpdatePlan, manifest: ClawManifest): Set<string> {
  const unchangedIds = new Set(
    plan.actions
      .filter((action) => action.kind === "package" && action.action === "unchanged")
      .map((action) => action.id),
  );
  const paths = new Set<string>();
  manifest.packages.forEach((pkg, index) => {
    if (unchangedIds.has(`${pkg.kind}:${pkg.ref}`)) {
      paths.add(`$.packages[${index}]`);
    }
  });
  return paths;
}

export async function applyClawUpdatePlan(
  plan: ClawUpdatePlan,
  params: {
    targetManifest: ClawManifest;
    targetClawMarkdownBody?: Buffer;
    targetOpenClawProfile?: ClawOpenClawProfile;
    targetSource: ClawSourceIdentity;
  },
  options: OpenClawStateDatabaseOptions & {
    config: OpenClawConfig;
    sourceMcpServers: Record<string, Record<string, unknown>>;
    consentPlanIntegrity: string | undefined;
    skipManual?: boolean;
    packagePreflight?: ClawAddPlanContext["packagePreflight"];
    runtime?: RuntimeEnv;
    commitConfig?: ConfigCommit;
    rebuildPlan?: typeof buildClawUpdatePlan;
    buildAddPlan?: typeof buildClawAddPlan;
    readInstall?: typeof readClawInstallRecord;
    persistInstall?: typeof updateClawInstallRecord;
    applyWorkspace?: typeof applyClawWorkspaceUpdate;
    applyMcp?: typeof applyClawMcpUpdate;
    applyCron?: typeof applyClawCronUpdate;
    applyPackage?: typeof applyClawPackageUpdate;
    cronGateway?: ClawCronGateway;
  },
): Promise<ClawUpdateResult> {
  if (options.consentPlanIntegrity !== plan.planIntegrity) {
    throw new ClawUpdateMutationError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw update plan; run update --dry-run again.",
    );
  }
  if (
    !plan.found ||
    plan.blockers.length > 0 ||
    (!options.skipManual && plan.actions.some((action) => action.blocked))
  ) {
    throw new ClawUpdateMutationError(
      "update_blocked",
      "The Claw update plan contains blockers or manual actions.",
    );
  }

  const rebuildPlan = options.rebuildPlan ?? buildClawUpdatePlan;
  const fresh = await rebuildPlan({
    agentId: plan.agentId,
    targetManifest: params.targetManifest,
    targetClawMarkdownBody: params.targetClawMarkdownBody,
    targetOpenClawProfile: params.targetOpenClawProfile,
    targetSource: params.targetSource,
    config: options.config,
    sourceMcpServers: options.sourceMcpServers,
    stateOptions: options,
    packagePreflight: options.packagePreflight,
  });
  if (
    fresh.planIntegrity !== plan.planIntegrity ||
    stableStringify(comparablePlan(fresh)) !== stableStringify(comparablePlan(plan))
  ) {
    throw new ClawUpdateMutationError(
      "update_changed",
      "Claw-owned state changed after update planning; build a new dry-run plan.",
    );
  }

  const appliedActions = options.skipManual
    ? fresh.actions.filter((action) => !action.blocked)
    : fresh.actions;
  const actionable = appliedActions.filter((action) => action.action !== "unchanged");
  const unsupported = actionable.filter(
    (action) =>
      action.kind !== "agent" &&
      action.kind !== "workspaceFile" &&
      action.kind !== "mcpServer" &&
      action.kind !== "cronJob" &&
      action.kind !== "package",
  );
  if (unsupported.length > 0) {
    throw new ClawUpdateMutationError(
      "unsupported_update_actions",
      `This update slice cannot yet apply: ${unsupported.map((action) => `${action.kind}:${action.id}`).join(", ")}.`,
    );
  }
  if (!fresh.currentClaw || !fresh.targetClaw) {
    throw new ClawUpdateMutationError("update_invalid", "The Claw update plan lacks identity.");
  }

  const buildAddPlan = options.buildAddPlan ?? buildClawAddPlan;
  const readInstall = options.readInstall ?? readClawInstallRecord;
  const currentInstall = readInstall(fresh.agentId, options);
  if (!currentInstall) {
    throw new ClawUpdateMutationError("update_changed", "The Claw install record disappeared.");
  }
  const partialMutation = (message: string): ClawUpdateMutationError => {
    try {
      updateClawInstallRecordStatus(fresh.agentId, "partial", options);
    } catch {
      // Preserve the owner failure; doctor can still reconcile subordinate pending records.
    }
    return new ClawUpdateMutationError("update_partial", message);
  };
  const targetAddPlan = await buildAddPlan({
    manifest: params.targetManifest,
    clawMarkdownBody: params.targetClawMarkdownBody,
    includePackageBootstrap: false,
    openClawProfile: params.targetOpenClawProfile,
    source: params.targetSource,
    context: {
      agentId: fresh.agentId,
      workspace: currentInstall.workspace,
      packagePreflight: async (pkg, workspace) => {
        const preflight = options.packagePreflight
          ? await options.packagePreflight(pkg, workspace)
          : {
              ok: false,
              code: "package_install_unavailable",
              message: "Package preflight is unavailable.",
            };
        return coercePluginVersionConflictForUpdate(preflight, pkg, (candidate) =>
          fresh.actions.some(
            (action) =>
              action.kind === "package" &&
              action.id === `${candidate.kind}:${candidate.ref}` &&
              action.action === "change",
          ),
        );
      },
    },
  });
  const unchangedPaths = unchangedPackagePaths(fresh, params.targetManifest);
  if (
    targetAddPlan.blockers.some(
      (blocker) =>
        blocker.code !== "agent_id_collision" &&
        blocker.code !== "workspace_collision" &&
        !(blocker.code === "skill_version_conflict" && unchangedPaths.has(blocker.path)),
    )
  ) {
    throw new ClawUpdateMutationError(
      "update_target_blocked",
      "The target Claw cannot be safely materialized for update.",
    );
  }
  for (const action of appliedActions.filter(
    (candidate) => candidate.kind === "package" && candidate.action === "unchanged",
  )) {
    const addAction = targetAddPlan.actions.find(
      (candidate) => candidate.kind === "package" && candidate.id === action.id,
    );
    if (!addAction || addAction.details?.expectedState === "absent") {
      throw new ClawUpdateMutationError(
        "update_changed",
        `Package ${JSON.stringify(action.id)} is no longer present; build a new dry-run plan.`,
      );
    }
  }
  const targetPackages = clawTargetPackages(params.targetManifest, params.targetOpenClawProfile);
  for (const action of appliedActions.filter(
    (candidate) =>
      candidate.kind === "package" &&
      candidate.action !== "unchanged" &&
      candidate.action !== "release" &&
      candidate.action !== "remove",
  )) {
    const target = targetPackages.get(action.id);
    const addAction = targetAddPlan.actions.find(
      (candidate) => candidate.kind === "package" && candidate.id === action.id,
    );
    const details = addAction?.details;
    if (
      !target ||
      action.desiredDigest !==
        digest({
          package: target,
          integrity: details?.integrity,
          installId: details?.installId,
          riskWarning: details?.riskWarning,
          prerequisites: details?.prerequisites,
          extension: details?.extension,
        })
    ) {
      throw new ClawUpdateMutationError(
        "update_changed",
        `Resolved package ${JSON.stringify(action.id)} changed after update planning; build a new dry-run plan.`,
      );
    }
  }

  const applyPackage = options.applyPackage ?? applyClawPackageUpdate;
  const requirementActions = appliedActions.filter(
    (action) =>
      action.kind === "package" &&
      action.action !== "unchanged" &&
      action.action !== "release" &&
      action.action !== "remove" &&
      targetPackages.get(action.id)?.kind === "plugin",
  );
  const remainingPackageActions = appliedActions.filter(
    (action) =>
      action.kind === "package" &&
      action.action !== "unchanged" &&
      !requirementActions.includes(action),
  );
  const applyPackageActions = async (
    actions: ClawUpdateAction[],
  ): Promise<ClawPackageUpdateExecution> => {
    if (actions.length === 0) {
      return { appliedIds: [], rollback: async () => undefined };
    }
    return await applyPackage({ ...fresh, actions }, params.targetManifest, targetAddPlan, options);
  };

  const agentAction = fresh.actions.find((action) => action.kind === "agent");
  const commit: ConfigCommit =
    options.commitConfig ??
    (async (transform) => {
      await transformConfigFileWithRetry({
        afterWrite: { mode: "auto" },
        transform: (config) => ({ nextConfig: transform(config) }),
      });
    });
  let previousAgent: AgentConfig | undefined;
  let agentChanged = false;
  const rollbackAgent = async (): Promise<void> => {
    if (!agentChanged) {
      return;
    }
    await commit((config) => {
      const current = listAgentEntries(config).find((agent) => agent.id === fresh.agentId);
      const targetDigest = `sha256:${createHash("sha256").update(stableStringify(targetAddPlan.agent.config)).digest("hex")}`;
      const liveDigest = current
        ? `sha256:${createHash("sha256").update(stableStringify(current)).digest("hex")}`
        : undefined;
      if (liveDigest !== targetDigest) {
        throw new Error("The agent changed before rollback.");
      }
      const nextEntries = { ...config.agents?.entries };
      if (previousAgent) {
        const { id: _id, ...previousEntry } = previousAgent;
        nextEntries[fresh.agentId] = previousEntry;
      } else {
        delete nextEntries[fresh.agentId];
      }
      return { ...config, agents: { ...config.agents, entries: nextEntries } };
    });
    agentChanged = false;
  };
  const applyWorkspace = options.applyWorkspace ?? applyClawWorkspaceUpdate;
  const applyMcp = options.applyMcp ?? applyClawMcpUpdate;
  const applyCron = options.applyCron ?? applyClawCronUpdate;
  const persistInstall = options.persistInstall ?? updateClawInstallRecord;

  let installRecord: PersistedClawInstall | undefined;
  await runOwnedUpdateSteps(
    [
      {
        name: "requirements",
        retainedOnApply: true,
        apply: () => applyPackageActions(requirementActions),
        onError: (error) =>
          error instanceof ClawPackageUpdateError && error.partial
            ? { kind: "partial", message: error.message }
            : { kind: "fail", code: "package_update_failed", message: coerceErrorMessage(error) },
      },
      {
        name: "workspace",
        apply: async () => {
          const execution = await applyWorkspace(
            { ...fresh, actions: appliedActions },
            targetAddPlan,
            options,
          );
          return { appliedIds: execution.appliedPaths, rollback: execution.rollback };
        },
        onError: (error, { retainedRequirements }) =>
          error instanceof ClawWorkspaceUpdateError && error.partial
            ? { kind: "partial", message: error.message }
            : retainedRequirements
              ? {
                  kind: "partial",
                  message: `${coerceErrorMessage(error)}; successfully realized shared requirements were retained`,
                }
              : {
                  kind: "fail",
                  code: "workspace_update_failed",
                  message: coerceErrorMessage(error),
                },
      },
      {
        name: "mcp",
        apply: async () => {
          const execution = await applyMcp(
            { ...fresh, actions: appliedActions },
            params.targetManifest,
            options,
          );
          return { appliedIds: execution.appliedNames, rollback: execution.rollback };
        },
        rollbackAfter: ["workspace"],
        onError: (error, { retainedRequirements }) =>
          error instanceof ClawMcpUpdateError && error.partial
            ? {
                kind: "partial",
                message: `${error.message}; MCP config write outcome is uncertain`,
              }
            : retainedRequirements
              ? {
                  kind: "partial",
                  message: `${coerceErrorMessage(error)}; successfully realized shared requirements were retained`,
                }
              : { kind: "fail", code: "mcp_update_failed", message: coerceErrorMessage(error) },
      },
      {
        name: "package",
        apply: () => applyPackageActions(remainingPackageActions),
        rollbackAfter: ["mcp", "workspace"],
        onError: (error, { retainedRequirements }) =>
          error instanceof ClawPackageUpdateError && error.partial
            ? {
                kind: "partial",
                message: `${coerceErrorMessage(error)}; package artifact rollback is unavailable`,
              }
            : retainedRequirements
              ? {
                  kind: "partial",
                  message: `${coerceErrorMessage(error)}; successfully realized shared requirements were retained`,
                }
              : { kind: "fail", code: "package_update_failed", message: coerceErrorMessage(error) },
      },
      {
        name: "agent",
        apply: async () => {
          if (agentAction?.action !== "change") {
            return { appliedIds: [], rollback: async () => undefined };
          }
          await commit((config) => {
            const current = listAgentEntries(config).find((agent) => agent.id === fresh.agentId);
            previousAgent = current;
            if (agentAction.currentDigest !== undefined) {
              if (!current) {
                throw new ClawUpdateMutationError(
                  "agent_changed",
                  "The owned agent entry disappeared during update.",
                );
              }
              const liveDigest = `sha256:${createHash("sha256").update(stableStringify(current)).digest("hex")}`;
              if (liveDigest !== agentAction.currentDigest) {
                throw new ClawUpdateMutationError(
                  "agent_changed",
                  "The owned agent entry changed during update.",
                );
              }
            }
            const nextEntries = { ...config.agents?.entries };
            const { id: _id, ...targetEntry } = targetAddPlan.agent.config;
            nextEntries[fresh.agentId] = targetEntry;
            agentChanged = true;
            return { ...config, agents: { ...config.agents, entries: nextEntries } };
          });
          return { appliedIds: [], rollback: rollbackAgent };
        },
        ownRollback: rollbackAgent,
        rollbackAfter: ["package", "mcp", "workspace"],
        onError: (error, { retainedRequirements }) =>
          retainedRequirements
            ? {
                kind: "partial",
                message: `${coerceErrorMessage(error)}; successfully realized shared requirements were retained`,
              }
            : error instanceof ClawUpdateMutationError
              ? { kind: "rethrow", error }
              : { kind: "fail", code: "agent_update_failed", message: coerceErrorMessage(error) },
      },
      {
        name: "cron",
        apply: async () => {
          const execution = await applyCron(
            { ...fresh, actions: appliedActions },
            params.targetManifest,
            options,
          );
          return { appliedIds: execution.appliedIds, rollback: execution.rollback };
        },
        rollbackAfter: ["agent", "package", "mcp", "workspace"],
        onError: async (error, { retainedRequirements }) => {
          if (error instanceof ClawCronUpdateError && error.partial) {
            try {
              persistInstall(targetAddPlan, {
                ...options,
                expectedClaw: fresh.currentClaw,
                status: "partial",
              });
            } catch (persistError) {
              return {
                kind: "partial",
                message: `${error.message}; cron gateway mutation outcome is uncertain; provenance update failed: ${coerceErrorMessage(persistError)}`,
              };
            }
            return {
              kind: "partial",
              message: `${error.message}; cron gateway mutation outcome is uncertain`,
            };
          }
          return retainedRequirements
            ? {
                kind: "partial",
                message: `${coerceErrorMessage(error)}; successfully realized shared requirements were retained`,
              }
            : { kind: "fail", code: "cron_update_failed", message: coerceErrorMessage(error) };
        },
      },
      {
        name: "provenance",
        apply: async () => {
          installRecord = persistInstall(targetAddPlan, {
            ...options,
            expectedClaw: fresh.currentClaw,
          });
          return { appliedIds: [], rollback: async () => undefined };
        },
        rollbackAfter: ["agent", "package", "cron", "mcp", "workspace"],
        onError: (error, { retainedRequirements }) =>
          retainedRequirements
            ? {
                kind: "partial",
                message: `${coerceErrorMessage(error)}; successfully realized shared requirements were retained`,
              }
            : {
                kind: "fail",
                code: "provenance_update_failed",
                message: coerceErrorMessage(error),
              },
      },
    ],
    {
      fail: (code, message) => new ClawUpdateMutationError(code, message),
      partial: partialMutation,
    },
  );
  if (!installRecord) {
    throw new ClawUpdateMutationError(
      "update_invalid",
      "The Claw update produced no install record.",
    );
  }

  return {
    schemaVersion: CLAW_UPDATE_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    mutationAllowed: true,
    status: "complete",
    agentId: fresh.agentId,
    previousClaw: fresh.currentClaw,
    targetClaw: fresh.targetClaw,
    appliedActions: actionable,
    ...(options.skipManual
      ? { skippedActions: fresh.actions.filter((action) => action.blocked) }
      : {}),
    installRecord,
  };
}
