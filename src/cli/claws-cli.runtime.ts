import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { stableStringify } from "@openclaw/normalization-core";
import {
  listAgentEntries,
  listAgentIds,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope-config.js";
import {
  applyClawAddPlan,
  CLAW_ADD_RESULT_SCHEMA_VERSION,
  ClawAddMutationError,
} from "../claws/add.js";
import {
  findClawExtensionPackageCollisions,
  planClawExtensions,
} from "../claws/application-plan.js";
import { assertExperimentalClawsEnabled } from "../claws/experimental.js";
import {
  CLAW_EXPORT_RESULT_SCHEMA_VERSION,
  ClawExportError,
  exportClawAgent,
} from "../claws/export.js";
import {
  applyClawRemovePlan,
  buildClawRemovePlan,
  CLAW_REMOVE_PLAN_SCHEMA_VERSION,
  CLAW_REMOVE_RESULT_SCHEMA_VERSION,
  ClawRemoveError,
  readClawStatus,
} from "../claws/lifecycle-state.js";
import { buildClawAddPlan } from "../claws/lifecycle.js";
import {
  findResumableIntroducedPluginRequirement,
  readClawResumeStateReadOnly,
} from "../claws/package-resume.js";
import { preflightClawPackage } from "../claws/packages.js";
import {
  clawInstallRecordMatchesPlan,
  readClawInstallRecord,
  readClawPackageRefs,
  type PersistedClawInstall,
} from "../claws/provenance.js";
import { readClawManifestFile } from "../claws/reader.js";
import {
  CLAW_INSPECT_RESULT_SCHEMA_VERSION,
  CLAW_ADD_PLAN_SCHEMA_VERSION,
  CLAW_OUTPUT_STABILITY,
  type ClawAddPlan,
} from "../claws/types.js";
// Runtime handlers for experimental local Claws commands.
import { getRuntimeConfig } from "../config/config.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { redactSensitiveArgv } from "../config/redact-argv.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePath,
} from "../cron/store.js";
import { redactSensitiveText } from "../logging/redact.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { authorizeLegacyV1Resume } from "./claws-cli-legacy-resume.js";
import { formatClawDiagnostics, logClawExperimentalWarning } from "./claws-cli-output.js";
import { waitUntilGatewayConfigApplied } from "./claws-cli.gateway-readiness.js";
import type {
  ClawsAddOptions,
  ClawsExportOptions,
  ClawsInspectOptions,
  ClawsRemoveOptions,
  ClawsStatusOptions,
} from "./claws-cli.js";
import { listCronJobsFromGateway } from "./cron-cli/list-jobs.js";
import { callGatewayFromCli } from "./gateway-rpc.js";

function logClawAddPlanSummary(plan: ClawAddPlan, runtime: RuntimeEnv): void {
  runtime.log(`Agent: ${plan.agent.finalId}`);
  runtime.log(`Workspace: ${plan.agent.workspace}`);
  runtime.log(`Actions: ${plan.summary.totalActions}`);
  runtime.log(`Packages: ${plan.summary.packageActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    const requirementState =
      typeof action.details?.requirementState === "string"
        ? action.details.requirementState
        : "unresolved";
    runtime.log(
      `  Requirement ${action.target}: ${requirementState}${action.action === "install" ? " (installation requires this exact plan consent)" : ""}`,
    );
  }
  runtime.log(`MCP servers: ${plan.summary.mcpServerActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    const server = action.details as Record<string, unknown> | undefined;
    const target =
      typeof server?.url === "string"
        ? redactSensitiveUrlLikeString(server.url)
        : typeof server?.command === "string"
          ? redactSensitiveArgv([
              server.command,
              ...(Array.isArray(server.args)
                ? server.args.filter((arg): arg is string => typeof arg === "string")
                : []),
            ]).join(" ")
          : "invalid declaration";
    runtime.log(`  MCP ${action.id}: ${target}`);
  }
  runtime.log(`Cron jobs: ${plan.summary.cronJobActions}`);
  if (plan.capabilityChanges.length > 0) {
    runtime.log(`Capability escalations (${plan.capabilityChanges.length}):`);
    for (const change of plan.capabilityChanges) {
      runtime.log(
        redactSensitiveText(`  ! ${change.kind}:${change.id} ${JSON.stringify(change.effect)}`),
      );
    }
    runtime.log("The plan integrity binds every capability line above.");
  }
  if (plan.summary.blockedActions > 0) {
    runtime.log(`Blocked actions: ${plan.summary.blockedActions}`);
  }
}

async function matchingResumeState(plan: ClawAddPlan, opts: ClawsAddOptions) {
  const readOnlyState = opts.dryRun
    ? await readClawResumeStateReadOnly(plan.agent.finalId)
    : undefined;
  const record = opts.dryRun ? readOnlyState?.record : readClawInstallRecord(plan.agent.finalId);
  if (
    !record ||
    record.status === "complete" ||
    record.workspace !== plan.agent.workspace ||
    record.claw.kind !== plan.claw.kind ||
    record.claw.name !== plan.claw.name ||
    record.claw.version !== plan.claw.version ||
    record.claw.integrity !== plan.claw.integrity
  ) {
    return undefined;
  }
  return {
    record,
    packageRefs: readOnlyState?.packageRefs ?? readClawPackageRefs({ agentId: plan.agent.finalId }),
  };
}

function failNonDryRun(opts: ClawsAddOptions, runtime: RuntimeEnv): boolean {
  if (opts.dryRun) {
    return false;
  }
  const consented = opts.yes && opts.planIntegrity;
  if (consented) {
    return false;
  }
  const code = opts.yes ? "plan_integrity_required" : "consent_required";
  const message = opts.yes
    ? "Claw add consent must include --plan-integrity from the exact dry-run plan."
    : "Claw add requires explicit consent; pass --dry-run to preview or --yes with --plan-integrity to create the new agent and workspace.";
  if (opts.json) {
    writeRuntimeJson(runtime, {
      schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      error: { code, message },
    });
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
  return true;
}

function requireRemoveConsent(opts: ClawsRemoveOptions, runtime: RuntimeEnv): boolean {
  if (opts.dryRun || (opts.yes && opts.planIntegrity)) {
    return false;
  }
  const code = opts.yes ? "plan_integrity_required" : "consent_required";
  const message = opts.yes
    ? "Claw remove consent must include --plan-integrity from the exact dry-run plan."
    : "Claw remove requires explicit consent; pass --dry-run to preview or --yes with --plan-integrity to remove owned state.";
  if (opts.json) {
    writeRuntimeJson(runtime, {
      schemaVersion: CLAW_REMOVE_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      error: { code, message },
    });
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
  return true;
}

export async function runClawsInspectCommand(
  sourcePath: string,
  opts: ClawsInspectOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const result = await readClawManifestFile(sourcePath);
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_INSPECT_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        valid: false,
        diagnostics: result.diagnostics,
      });
    } else {
      runtime.error(formatClawDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const extensionPlan = await planClawExtensions({
    extensions: result.openClawProfile?.extensions ?? [],
    workspace: result.source.packageRoot,
    packagePreflight: preflightClawPackage,
  });
  const extensionCollisions = findClawExtensionPackageCollisions({
    packages: result.manifest.packages,
    extensions: result.openClawProfile?.extensions ?? [],
  });
  const diagnostics = [
    ...result.diagnostics,
    ...extensionPlan.blockers,
    ...extensionCollisions.map(({ diagnostic }) => diagnostic),
  ];
  const valid = diagnostics.every((diagnostic) => diagnostic.level !== "error");
  const payload = {
    schemaVersion: CLAW_INSPECT_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    valid,
    source: result.source,
    manifest: result.manifest,
    ...(result.openClawProfile ? { openClawProfile: result.openClawProfile } : {}),
    extensions: extensionPlan.extensions,
    diagnostics,
  };
  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    if (!valid) {
      runtime.exit(1);
    }
    return;
  }
  logClawExperimentalWarning(runtime);
  runtime.log(`Claw: ${result.source.name}@${result.source.version}`);
  runtime.log(`Agent: ${result.manifest.agent.name ?? result.manifest.agent.id}`);
  runtime.log(`Packages: ${result.manifest.packages.length}`);
  runtime.log(`Extension requirements: ${extensionPlan.extensions.length}`);
  for (const extension of extensionPlan.extensions) {
    runtime.log(
      `  ${extension.id}: ${extension.requirementState}; ${extension.detectedFormat ?? "unresolved"} -> ${(extension.mapped ?? []).join(", ") || "no mapped capabilities"}`,
    );
  }
  runtime.log(`MCP servers: ${Object.keys(result.manifest.mcpServers).length}`);
  runtime.log(`Cron jobs: ${result.manifest.cronJobs.length}`);
  if (!valid) {
    runtime.error(formatClawDiagnostics(diagnostics));
    runtime.exit(1);
  }
}

export async function runClawsAddCommand(
  sourcePath: string,
  opts: ClawsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  if (failNonDryRun(opts, runtime)) {
    return;
  }
  let legacyV1ResumeRecord: PersistedClawInstall | undefined;
  const result = await readClawManifestFile(sourcePath, {
    authorizeLegacyDynamicToolProfile: ({ manifest, source }) => {
      legacyV1ResumeRecord = authorizeLegacyV1Resume({ manifest, source, opts });
      return legacyV1ResumeRecord !== undefined;
    },
  });
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        valid: false,
        diagnostics: result.diagnostics,
      });
    } else {
      runtime.error(formatClawDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const config = getRuntimeConfig();
  const listedMcpServers = await listConfiguredMcpServers();
  if (!listedMcpServers.ok) {
    runtime.error(listedMcpServers.error);
    runtime.exit(1);
    return;
  }
  const existingAgentIds = listAgentIds(config);
  const existingWorkspacePaths = existingAgentIds.map((agentId) =>
    resolveAgentWorkspaceDir(config, agentId),
  );
  const cronStore = await loadCronJobsStoreWithConfigJobsReadOnly(resolveCronJobsStorePath());
  const basePlanContext = {
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    ...(opts.adoptExistingWorkspace ? { adoptExistingWorkspace: true } : {}),
    existingAgentIds,
    existingWorkspacePaths,
    existingMcpServers: listedMcpServers.mcpServers,
    existingCronJobIds: cronStore.store.jobs.map((job) => job.id),
    packagePreflight: preflightClawPackage,
  };
  let plan = await buildClawAddPlan({
    manifest: result.manifest,
    clawMarkdownBody: result.clawMarkdownBody,
    packageBootstrap: result.packageBootstrap,
    openClawProfile: result.openClawProfile,
    source: result.source,
    diagnostics: result.diagnostics,
    context: basePlanContext,
  });
  let legacyResumePlan = result.legacyOpenClawProfile
    ? await buildClawAddPlan({
        manifest: result.manifest,
        clawMarkdownBody: result.clawMarkdownBody,
        packageBootstrap: result.packageBootstrap,
        openClawProfile: result.legacyOpenClawProfile,
        reconstructLegacyDynamicToolProfilePlan: true,
        source: result.source,
        diagnostics: result.diagnostics,
        context: basePlanContext,
      })
    : undefined;
  let resumableInstallRecord: PersistedClawInstall | undefined;
  const resumeState = await matchingResumeState(legacyResumePlan ?? plan, opts);
  if (result.legacyOpenClawProfile && !resumeState) {
    plan = {
      ...plan,
      blockers: [
        ...plan.blockers,
        {
          level: "error",
          code: "claw_resume_plan_mismatch",
          phase: "plan",
          path: "$",
          message:
            "The incomplete Claw add no longer matches the previously consented plan; remove its partial state before retrying.",
        },
      ],
    };
  }
  if (resumeState) {
    const { record: resumeRecord, packageRefs: resumePackageRefs } = resumeState;
    resumableInstallRecord = resumeRecord;
    const packagePreflight = async (
      pkg: Parameters<typeof preflightClawPackage>[0],
      workspace: string,
    ) => {
      const preflight = await preflightClawPackage(pkg, workspace);
      return findResumableIntroducedPluginRequirement({
        agentId: resumeRecord.agentId,
        pkg,
        preflight,
        refs: resumePackageRefs,
      })
        ? { ...preflight, action: "install" as const }
        : preflight;
    };
    const canResumeWorkspace =
      resumeRecord.status === "workspace_ready" || resumeRecord.status === "config_committed";
    const expectedCommittedAgentConfigs = legacyResumePlan
      ? [legacyResumePlan.agent.config, plan.agent.config]
      : [plan.agent.config];
    const committedAgent = listAgentEntries(config).find(
      (agent) =>
        agent.id === resumeRecord.agentId &&
        expectedCommittedAgentConfigs.some(
          (expected) => stableStringify(agent) === stableStringify(expected),
        ),
    );
    const canResumeAgent =
      resumeRecord.status === "config_committed" ||
      (resumeRecord.status === "workspace_ready" && committedAgent !== undefined);
    const resumePlanContext = {
      ...basePlanContext,
      packagePreflight,
      existingAgentIds: canResumeAgent
        ? existingAgentIds.filter((agentId) => agentId !== resumeRecord.agentId)
        : existingAgentIds,
      existingWorkspacePaths: canResumeWorkspace
        ? existingAgentIds
            .filter((agentId) => agentId !== resumeRecord.agentId)
            .map((agentId) => resolveAgentWorkspaceDir(config, agentId))
        : existingWorkspacePaths,
      ...(canResumeWorkspace ? { resumableWorkspace: resumeRecord.workspace } : {}),
    };
    plan = await buildClawAddPlan({
      manifest: result.manifest,
      clawMarkdownBody: result.clawMarkdownBody,
      packageBootstrap: result.packageBootstrap,
      openClawProfile: result.openClawProfile,
      source: result.source,
      diagnostics: result.diagnostics,
      context: resumePlanContext,
    });
    if (result.legacyOpenClawProfile) {
      legacyResumePlan = await buildClawAddPlan({
        manifest: result.manifest,
        clawMarkdownBody: result.clawMarkdownBody,
        packageBootstrap: result.packageBootstrap,
        openClawProfile: result.legacyOpenClawProfile,
        reconstructLegacyDynamicToolProfilePlan: true,
        source: result.source,
        diagnostics: result.diagnostics,
        context: resumePlanContext,
      });
    }
    const expectedResumePlan = legacyResumePlan ?? plan;
    const exactLegacyResume =
      !legacyResumePlan ||
      (legacyV1ResumeRecord !== undefined &&
        stableStringify(legacyV1ResumeRecord) === stableStringify(resumeRecord));
    if (
      plan.blockers.length === 0 &&
      (!exactLegacyResume || !clawInstallRecordMatchesPlan(resumeRecord, expectedResumePlan))
    ) {
      plan = {
        ...plan,
        blockers: [
          ...plan.blockers,
          {
            level: "error",
            code: "claw_resume_plan_mismatch",
            phase: "plan",
            path: "$",
            message:
              "The incomplete Claw add no longer matches the current plan; remove its partial state before retrying.",
          },
        ],
      };
    } else {
      resumableInstallRecord = resumeRecord;
    }
  }

  if (plan.blockers.length > 0) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      logClawExperimentalWarning(runtime);
      logClawAddPlanSummary(plan, runtime);
      runtime.error(formatClawDiagnostics(plan.blockers));
    }
    runtime.exit(1);
    return;
  }

  if (opts.dryRun) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      logClawExperimentalWarning(runtime);
      runtime.log(`Claw add plan: ${plan.claw.name}@${plan.claw.version}`);
      logClawAddPlanSummary(plan, runtime);
    }
    return;
  }

  const consentPlanIntegrity = legacyResumePlan?.planIntegrity ?? plan.planIntegrity;
  if (opts.planIntegrity !== consentPlanIntegrity) {
    const message = "The consented Claw plan no longer matches; run add --dry-run again.";
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        status: "failed",
        planIntegrity: plan.planIntegrity,
        error: { code: "plan_integrity_mismatch", message },
      });
    } else {
      runtime.error(message);
    }
    runtime.exit(1);
    return;
  }

  let addResult;
  if (!opts.json) {
    logClawExperimentalWarning(runtime);
  }
  try {
    addResult = await applyClawAddPlan(plan, {
      consentPlanIntegrity: opts.planIntegrity,
      resumeRecord: resumableInstallRecord,
      resumePlan: legacyResumePlan,
      runtime: opts.json ? { ...runtime, log: () => undefined } : runtime,
      cronGateway: {
        add: async (input) => await callGatewayFromCli("cron.add", {}, input),
        list: async (agentId) =>
          await listCronJobsFromGateway({}, { agentId, includeDisabled: true }),
        waitUntilAgentAvailable: async () => await waitUntilGatewayConfigApplied(),
      },
    });
  } catch (error) {
    const code = error instanceof ClawAddMutationError ? error.code : "add_failed";
    const message = (error as Error).message;
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        status: "failed",
        error: { code, message },
      });
    } else {
      runtime.error(message);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, addResult);
  } else {
    runtime.log(`Added agent: ${addResult.agent.finalId}`);
    runtime.log(`Workspace: ${addResult.agent.workspace}`);
    runtime.log(`Status: ${addResult.status}`);
  }
  if (addResult.status !== "complete") {
    runtime.exit(1);
  }
}

export async function runClawsStatusCommand(
  target: string | undefined,
  opts: ClawsStatusOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const status = await readClawStatus(target);
  if (opts.json) {
    writeRuntimeJson(runtime, status);
  } else {
    logClawExperimentalWarning(runtime);
    runtime.log(`Installed Claws: ${status.summary.claws}`);
    for (const record of status.records) {
      runtime.log(
        `${record.install.agentId}: ${record.install.claw.name}@${record.install.claw.version} (${record.install.status})`,
      );
      runtime.log(
        `  Agent: ${record.agentState}; bootstrap: ${record.bootstrapState}; files: ${record.workspaceFiles.length}; packages: ${record.packages.length}`,
      );
    }
  }
  if (target && status.records.length === 0) {
    runtime.exit(1);
  }
}

export { runClawsUpdateCommand } from "./claws-update-cli.runtime.js";

export async function runClawsRemoveCommand(
  target: string,
  opts: ClawsRemoveOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  if (requireRemoveConsent(opts, runtime)) {
    return;
  }
  const selected = opts.removeReferenced ?? [];
  if (opts.removeUnused && selected.length > 0) {
    runtime.error("Choose either --remove-unused or --remove-referenced, not both.");
    runtime.exit(1);
    return;
  }
  if (opts.forceReferenced && selected.length === 0) {
    runtime.error("--force-referenced requires at least one --remove-referenced selector.");
    runtime.exit(1);
    return;
  }
  const referencedCleanup = selected.length
    ? {
        mode: "remove-selected" as const,
        selected,
        allowConflicts: Boolean(opts.forceReferenced),
      }
    : opts.removeUnused
      ? { mode: "remove-if-unused" as const }
      : { mode: "retain" as const };
  const plan = await buildClawRemovePlan(target, { referencedCleanup });
  if (opts.dryRun || plan.blockers.length > 0) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      logClawExperimentalWarning(runtime);
      runtime.log(`Remove actions: ${plan.actions.length}`);
      runtime.log(`Plan integrity: ${plan.planIntegrity}`);
      for (const action of plan.actions.filter((candidate) => candidate.kind === "packageRef")) {
        runtime.log(
          `  Package ${action.target}: ${action.action}${action.reason ? ` (${action.reason})` : ""}`,
        );
      }
      for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
        runtime.log(
          `  MCP ${action.id}: ${action.action}${action.reason ? ` (${action.reason})` : ""}`,
        );
      }
      if (plan.blockers.length > 0) {
        runtime.error(plan.blockers.map((blocker) => blocker.message).join("\n"));
      }
    }
    if (plan.blockers.length > 0) {
      runtime.exit(1);
    }
    return;
  }
  try {
    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: opts.planIntegrity,
      referencedCleanup,
      cronGateway: {
        get: async (id) => await callGatewayFromCli("cron.get", {}, { id }),
        remove: async (id) => await callGatewayFromCli("cron.remove", {}, { id }),
      },
    });
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      logClawExperimentalWarning(runtime);
      runtime.log(`Removed agent: ${result.agentId}`);
      runtime.log(`Status: ${result.status}`);
      for (const pkg of result.packages) {
        runtime.log(
          `  Package ${pkg.kind}:${pkg.ref}@${pkg.version}: ${pkg.action}${pkg.reason ? ` (${pkg.reason})` : ""}`,
        );
      }
      runtime.log(`Package references released: ${result.packageRefsReleased}`);
    }
    if (result.status !== "complete") {
      runtime.exit(1);
    }
  } catch (error) {
    const code = error instanceof ClawRemoveError ? error.code : "remove_failed";
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        status: "failed",
        error: { code, message },
      });
    } else {
      runtime.error(message);
    }
    runtime.exit(1);
  }
}

export async function runClawsExportCommand(
  agentId: string,
  opts: ClawsExportOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  try {
    const listedMcpServers = await listConfiguredMcpServers();
    if (!listedMcpServers.ok) {
      throw new ClawExportError("mcp_config_unavailable", listedMcpServers.error);
    }
    const result = await exportClawAgent(agentId, opts.out, {
      config: getRuntimeConfig(),
      sourceMcpServers: listedMcpServers.mcpServers,
      ...(opts.bootstrap ? { bootstrapPath: opts.bootstrap } : {}),
    });
    if (opts.json) {
      writeRuntimeJson(runtime, result);
      return;
    }
    logClawExperimentalWarning(runtime);
    runtime.log(`Exported agent: ${result.agentId}`);
    runtime.log(`Package directory: ${result.outputDirectory}`);
    runtime.log(
      `Workspace files: ${result.manifest.workspace.files.length + Object.keys(result.manifest.workspace.bootstrapFiles).length}`,
    );
    runtime.log(`Packages: ${result.manifest.packages.length}`);
    runtime.log(`Bootstrap: ${result.filesWritten.includes("BOOTSTRAP.md") ? "included" : "none"}`);
  } catch (error) {
    const code = error instanceof ClawExportError ? error.code : "export_failed";
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_EXPORT_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        status: "failed",
        error: { code, message },
      });
    } else {
      runtime.error(message);
    }
    runtime.exit(1);
  }
}
